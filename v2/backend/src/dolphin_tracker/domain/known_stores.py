"""Stores we already know, offered to a sheet being imported. Pure.

A sheet often lists stores that are already in another project of the tracker, or in the CMS data (every venue
the CMS reports). For those the work is done: the address was verified (or fixed by hand) and the DD codes are known.
The import reuses it instead of asking Google again.

Matching rule: the same PA, and then the same ExtID or the same address. Never the address alone (two shops can share
one; the same address under another PA is another store), and never the ExtID across PAs (it is only unique within
one).

- The address and map location come from the tracker's store when it has a verified one (someone may have corrected
  it there), else from the CMS data.
- The screens (DD code, stick number, status) come from the CMS data when it has the store, else from the
  tracker's store. They fill the sheet's rows that have no DD code before adding rows.
"""
from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from dolphin_tracker.domain.device import split_codes, venue_code_key
from dolphin_tracker.domain.import_mapping import dedupe_key_address
from dolphin_tracker.domain.lists import name_key
from dolphin_tracker.domain.models import NeedsAttention, Project, ScreenStatus, Stop
from dolphin_tracker.domain.validation import normalize_external_id

TRACKER, DOLPHIN = "tracker", "dolphin_data"
DOLPHIN_LABEL = "the CMS data"
CLOSED = frozenset({ScreenStatus.CANCELLED, ScreenStatus.ARCHIVED})


def pa_keys(value: str) -> set[str]:
    """The PA names in a PA value ("North, South"), as compared."""
    return {key for part in value.split(",") if (key := name_key(part))}


@dataclass(frozen=True)
class KnownStore:
    source: str  # TRACKER or DOLPHIN
    label: str  # the project's name, or "the CMS data"
    stop: Stop
    external_id: str  # normalised; "" when it has none

    @property
    def located(self) -> bool:
        """A verified address with a pin: one nobody is still asked to check."""
        stop = self.stop
        return (stop.lat is not None and stop.lng is not None and bool(stop.addr.strip())
                and NeedsAttention.ADDRESS not in stop.needs_attention)


@dataclass
class KnownMatch:
    tracker: KnownStore | None = None
    dolphin: list[KnownStore] = field(default_factory=list)  # one per venue (screen) of the store

    def __bool__(self) -> bool:
        return self.tracker is not None or bool(self.dolphin)

    @property
    def location(self) -> KnownStore | None:
        """Where the verified address comes from: the tracker's store first, else the CMS data."""
        candidates = ([self.tracker] if self.tracker else []) + self.dolphin
        return next((known for known in candidates if known.located), None)

    @property
    def screens(self) -> list[dict[str, Any]]:
        """The known screens that carry a DD code: the CMS data's when it has the store, else the tracker's."""
        stores = self.dolphin or ([self.tracker] if self.tracker else [])
        rows: list[dict[str, Any]] = []
        for known in stores:
            for screen in known.stop.screens:
                if venue_code_key(screen.venue_id) and len(split_codes(screen.venue_id)) == 1:
                    rows.append({"stick_number": screen.stick_number, "venue_id": screen.venue_id,
                                 "status": screen.status.value})
        return rows

    @property
    def screen_source(self) -> str:
        return DOLPHIN_LABEL if self.dolphin else (f"project {self.tracker.label}" if self.tracker else "")


class KnownStores:
    """Every known store, looked up by (PA, ExtID) and (PA, address)."""

    def __init__(self) -> None:
        self._by_id: dict[tuple[str, str], list[KnownStore]] = {}
        self._by_address: dict[tuple[str, str], list[KnownStore]] = {}
        # A project's own PA name → the name the CMS uses for it (the project's device PA), so a sheet that says
        # "IBC" also finds the CMS data's "IBC Bakeries".
        self._aliases: dict[str, set[str]] = {}
        self.count = 0

    def _add(self, known: KnownStore, pas: Iterable[str]) -> None:
        stop = known.stop
        address = dedupe_key_address({"addr": stop.addr, "city": stop.city, "state": stop.state, "zip": stop.zip})
        for pa in pas:
            if known.external_id:
                self._by_id.setdefault((pa, known.external_id), []).append(known)
            if address:
                self._by_address.setdefault((pa, address), []).append(known)
        self.count += 1

    def add_project(self, project: Project, stops: Iterable[Stop]) -> None:
        device_pa = name_key(project.device_pa)
        if device_pa:
            for pa in pa_keys(project.pa):
                self._aliases.setdefault(pa, set()).add(device_pa)
        for stop in stops:
            pas = pa_keys(stop.pa or project.pa) | ({device_pa} if device_pa else set())
            self._add(KnownStore(TRACKER, project.name, stop, normalize_external_id(stop.external_id)), pas)

    def add_venues(self, stops: Iterable[Stop]) -> None:
        """The all-venues list (`domain/venues.py`): one store per venue, its ExtID kept as the display id."""
        for stop in stops:
            self._add(KnownStore(DOLPHIN, DOLPHIN_LABEL, stop, normalize_external_id(stop.display_id)),
                      pa_keys(stop.pa))

    def match(self, pa: str, external_id: str, address: dict[str, Any]) -> KnownMatch:
        """What is known about a sheet row of this PA. Empty without a PA: the PA is half of every match."""
        pas = pa_keys(pa)
        pas |= {alias for key in list(pas) for alias in self._aliases.get(key, ())}
        external_id = normalize_external_id(external_id)
        address_key = dedupe_key_address(address)
        found: list[KnownStore] = []
        for key in pas:
            if external_id:
                found += self._by_id.get((key, external_id), [])
            if address_key:
                found += self._by_address.get((key, address_key), [])
        match = KnownMatch()
        seen: set[int] = set()
        for known in found:  # ExtID matches come first for each PA
            if id(known) in seen:
                continue
            seen.add(id(known))
            if known.source == TRACKER:
                match.tracker = match.tracker or known
            else:
                match.dolphin.append(known)
        return match


def merge_known_screens(
    screens: list[dict[str, Any]], known: list[dict[str, Any]], used: set[str]
) -> tuple[list[dict[str, Any]], int]:
    """The sheet's screen rows with the known screens taken in. A known DD code the sheet (or an earlier row) already
    has is skipped: a DD code is one device. Otherwise it fills a row waiting for a DD code (one with its stick number
    first, else one with no stick number; never a Cancelled or Archived row), and only becomes a new row when none is
    left. The row takes the known status. Returns (rows, how many DD codes were taken); `used` is updated."""
    rows = [dict(screen) for screen in screens]
    taken = 0
    for screen in known:
        key = venue_code_key(screen["venue_id"])
        if not key or key in used:
            continue
        used.add(key)
        taken += 1
        empty = [row for row in rows if not venue_code_key(row.get("venue_id")) and row.get("status") not in CLOSED]
        serial = str(screen.get("stick_number") or "").strip().lower()
        target = next((row for row in empty if serial and str(row.get("stick_number") or "").strip().lower() == serial),
                      None) or next((row for row in empty if not str(row.get("stick_number") or "").strip()), None)
        if target is None:
            rows.append(dict(screen))
        else:
            target.update(venue_id=screen["venue_id"], status=screen["status"],
                          stick_number=str(target.get("stick_number") or "").strip() or screen.get("stick_number", ""))
    return rows, taken
