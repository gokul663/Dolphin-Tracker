"""Sheet columns → store fields (STORE-MODEL §6). Pure: header detection, saved overrides, typed row values.

A *mapping* is `{normalised header: target}`. A target is a store attribute, one of the screen/status helpers
below, `FIELDS` ("" — keep the value under "Other imported data") or `IGNORE` (drop the column). Each target is
taken by at most one column; the first column wins.
"""
from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import date, datetime
from itertools import zip_longest
from typing import Any

from dolphin_tracker.domain.addresses import normalized_address_key, parse_us_formatted_address, state_code
from dolphin_tracker.domain.parsing import ADDRESS_ALIASES, clean_cell
from dolphin_tracker.domain.statuses import ScreenStatus, normalize_screen_status
from dolphin_tracker.domain.validation import (
    FIELDS_BY_NAME,
    Kind,
    field_error,
    normalize_external_id,
    parse_count,
    parse_tri_state,
)

FIELDS = ""  # the column's values go to `fields` under its normalised header
IGNORE = "-"

# Targets that are not store attributes: they build the screen rows and the status (§4.1, §4.3).
STATUS = "status"
STATUS_FALLBACK = "status_fallback"  # "Shipment / Device status": used when STATUS is blank
SCREEN_COUNT = "screen_count"  # "No of Sticks": how many rows when there are no stick numbers / venue ids
STICK_NUMBERS = "stick_numbers"
VENUE_IDS = "venue_ids"
SHEET_ONLY_TARGETS = ("lat", "lng", "installer_name", STATUS, STATUS_FALLBACK, SCREEN_COUNT, STICK_NUMBERS, VENUE_IDS)

# §6, after normalize_column. Round-1 aliases kept where they don't conflict (site_address, *_name variants).
HEADER_MAP: dict[str, str] = {
    **dict.fromkeys(("ibc", "ibc_number", "external_id", "id"), "external_id"),
    **dict.fromkeys(("store_name", "store", "site_name", "name"), "store_name"),
    **dict.fromkeys(ADDRESS_ALIASES, "addr"),
    "city": "city",
    "state": "state",
    **dict.fromkeys(("zip", "zipcode", "zip_code", "postal_code"), "zip"),
    **dict.fromkeys(("latitude", "lat"), "lat"),
    **dict.fromkeys(("longitude", "lng", "long"), "lng"),
    **dict.fromkeys(("pa", "pa_name", "principal_agent", "principal_agent_name"), "pa"),
    **dict.fromkeys(("dma", "dma_name", "market", "market_name"), "dma"),
    **dict.fromkeys(("venue_type", "venue", "site_type", "location_type"), "venue_type"),
    "date": "source_date",
    "status": STATUS,
    "shipment_device_status": STATUS_FALLBACK,
    "technician": "installer_name",
    **dict.fromkeys(("no_of_sticks", "number_of_sticks"), SCREEN_COUNT),
    **dict.fromkeys(("stick_number", "stick_numbers"), STICK_NUMBERS),
    **dict.fromkeys(("venue_id", "venue_ids", "dd_code"), VENUE_IDS),
    **dict.fromkeys(("store_owner_name", "owner_name"), "owner_name"),
    **dict.fromkeys(("store_owner_number", "owner_phone", "owner_number"), "owner_phone"),
    **dict.fromkeys(("store_owner_email", "owner_email"), "owner_email"),
    **dict.fromkeys(("on_site_contact_name", "onsite_contact_name"), "onsite_contact_name"),
    **dict.fromkeys(("on_site_contact_phone", "onsite_contact_phone"), "onsite_contact_phone"),
    "outlet_status": "outlet_status",
    "best_contact_time": "best_contact_time",
    "preferred_language": "preferred_language",
    "how_many_screens_does_store_want": "committed_dolphin_screens",
    "how_many_tvs_are_in_the_store": "committed_store_tvs",
    "preferred_area_in_store": "preferred_area",
    "spot_visible_from_most_of_store": "spot_visible",
    "power_outlet_within_6_ft_of_install_spot": "power_within_6ft",
    "can_ethernet_be_run_to_install_spot": "ethernet_possible",
    "is_low_volume_audio_acceptable": "low_volume_audio_ok",
    "is_ceiling_suitable_for_mounting": "ceiling_suitable",
    "ceiling_type": "ceiling_type",
    "approx_ceiling_height": "ceiling_height",
    "nearest_power_outlet": "nearest_power_outlet",
    "ethernet_cable_route": "ethernet_route",
    "store_ssid": "store_ssid",
    "store_ssid_password": "store_ssid_password",
    **dict.fromkeys(("account_program_pictures_image_url", "image_url"), "image_url"),
    "blocked_dates_notes": "blocked_dates_notes",
    "preferred_install_date_time": "preferred_install_datetime",
    "products_content_to_avoid": "products_to_avoid",
    **dict.fromkeys(("installation_comments", "installation_notes"), "installation_notes"),
    "cms_details_added": "cms_details_added",
}
TARGETS: frozenset[str] = frozenset(
    {*HEADER_MAP.values(), *(name for name in FIELDS_BY_NAME if name != "pa"), "pa", *SHEET_ONLY_TARGETS}
)
CORE_TARGETS = ("external_id", "store_name", "addr", "city", "state", "zip", "pa")


def detect_mapping(columns: Iterable[str], saved: Mapping[str, str] | None = None) -> dict[str, str]:
    """The mapping for `columns`: a saved choice first (`project.import_mappings`), then §6, else FIELDS.
    One column per target; a later column that would take a target already taken goes to FIELDS."""
    saved = saved or {}
    mapping: dict[str, str] = {}
    taken: set[str] = set()
    for column in columns:
        target = saved.get(column)
        if target is None or (target not in TARGETS and target not in (FIELDS, IGNORE)):
            target = HEADER_MAP.get(column, FIELDS)
        if target in taken:
            target = FIELDS
        if target not in (FIELDS, IGNORE):
            taken.add(target)
        mapping[column] = target
    return mapping


def check_mapping(mapping: Mapping[str, str]) -> list[str]:
    """Problems with a mapping a client sends back (re-pointed columns): unknown or doubly used targets."""
    errors = []
    seen: dict[str, str] = {}
    for column, target in mapping.items():
        if target not in TARGETS and target not in (FIELDS, IGNORE):
            errors.append(f"Column '{column}': unknown field '{target}'")
        elif target not in (FIELDS, IGNORE):
            if target in seen:
                errors.append(f"Columns '{seen[target]}' and '{column}' both map to '{target}'")
            seen[target] = column
    if "addr" not in seen:
        errors.append("One column must map to the store address")
    return errors


def clean_mapping(mapping: Mapping[str, str]) -> dict[str, str]:
    """The entries of a client-sent mapping worth saving: known targets only, at most 500 columns."""
    allowed = TARGETS | {FIELDS, IGNORE}
    return {str(column)[:200]: target for column, target in list(mapping.items())[:500] if target in allowed}


def _split_list(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]


def _date(value: str) -> str:
    """ISO date when the cell is a recognisable date (XLSX datetimes, YYYY-MM-DD, M/D/YYYY, M/D/YY), else as is."""
    text = value.strip()
    if not text:
        return ""
    head = text.split(" ")[0].split("T")[0]
    for parse in (date.fromisoformat, lambda raw: datetime.strptime(raw, "%m/%d/%Y").date(),
                  lambda raw: datetime.strptime(raw, "%m/%d/%y").date()):
        try:
            return parse(head).isoformat()
        except ValueError:
            continue
    return text


def _coordinate(value: str, limit: float) -> float | None:
    try:
        number = float(value)
    except ValueError:
        return None
    return number if -limit <= number <= limit else None


@dataclass
class MappedRow:
    """One sheet row in store terms, before geocoding."""

    index: int
    address: str  # the raw address cell, as uploaded
    store_name: str = ""
    external_id: str = ""
    addr: str = ""
    city: str = ""
    state: str = ""
    zip: str = ""
    pa: str = ""
    sheet_lat: float | None = None
    sheet_lng: float | None = None
    installer_name: str = ""
    status: ScreenStatus = ScreenStatus.UPCOMING
    status_valid: bool = True
    status_raw: str = ""
    details: dict[str, Any] = field(default_factory=dict)  # every other first-class attribute the sheet has
    screens: list[dict[str, Any]] = field(default_factory=list)
    fields: dict[str, str] = field(default_factory=dict)
    problems: dict[str, str] = field(default_factory=dict)  # attribute → why its sheet value was not used


def _typed(name: str, raw: str, row: MappedRow) -> Any:
    """A sheet cell as the attribute's type. Unusable values are recorded in `row.problems`."""
    spec = FIELDS_BY_NAME[name]
    match spec.kind:
        case Kind.INT:
            count = parse_count(raw)
            if raw and count is None:
                row.problems[name] = f"{spec.label}: '{raw}' is not a number"
            return count
        case Kind.TRISTATE:
            return parse_tri_state(raw)
        case Kind.BOOL:
            return parse_tri_state(raw) is True
        case Kind.SELECT:
            option = next((option for option in spec.options if option.lower() == raw.lower()), None)
            if raw and option is None:
                row.problems[name] = f"{spec.label}: '{raw}' is not one of {', '.join(spec.options)}"
            return option or ""
        case _:
            message = field_error(spec, raw)
            if message:
                row.problems[name] = message  # kept as typed, flagged for the review step
            return raw


def build_screens(row: Mapping[str, str], status: ScreenStatus) -> list[dict[str, Any]]:
    """Screen rows (§4.1): stick numbers and venue ids zipped (shorter list padded); when both are empty,
    `max(1, No of Sticks)` rows with empty identifiers. Every row takes the sheet status."""
    sticks = _split_list(row.get(STICK_NUMBERS, ""))
    venues = _split_list(row.get(VENUE_IDS, ""))
    if sticks or venues:
        pairs = list(zip_longest(sticks, venues, fillvalue=""))
    else:
        pairs = [("", "")] * max(1, parse_count(row.get(SCREEN_COUNT, "")) or 1)
    return [{"stick_number": stick, "venue_id": venue, "status": status.value} for stick, venue in pairs]


def map_row(index: int, record: Mapping[str, str], mapping: Mapping[str, str]) -> MappedRow:
    """Apply `mapping` to one parsed sheet row (cells keyed by normalised header)."""
    by_target = {
        target: clean_cell(record.get(column, ""))
        for column, target in mapping.items()
        if target not in (FIELDS, IGNORE)
    }
    row = MappedRow(index=index, address=by_target.get("addr", ""))
    row.fields = {
        column: value
        for column, target in mapping.items()
        if target == FIELDS and (value := clean_cell(record.get(column, "")))
    }
    row.store_name = by_target.get("store_name", "")
    row.external_id = normalize_external_id(by_target.get("external_id", ""))
    row.pa = by_target.get("pa", "")
    row.addr, row.city, row.zip = by_target.get("addr", ""), by_target.get("city", ""), by_target.get("zip", "")
    row.state = state_code(by_target.get("state", ""))
    if row.addr and not (row.city or row.state or row.zip):  # "street, city, ST 12345" in one column
        parsed = parse_us_formatted_address(row.addr, row.store_name)
        if parsed:
            row.addr, row.city, row.state, row.zip = parsed["addr"], parsed["city"], parsed["state"], parsed["zip"]
    row.sheet_lat = _coordinate(by_target.get("lat", ""), 90)
    row.sheet_lng = _coordinate(by_target.get("lng", ""), 180)
    if row.sheet_lat is None or row.sheet_lng is None:
        row.sheet_lat = row.sheet_lng = None
    row.installer_name = by_target.get("installer_name", "")

    raw_status = by_target.get(STATUS, "") or by_target.get(STATUS_FALLBACK, "")  # STATUS first (§4.3)
    row.status, row.status_valid = normalize_screen_status(raw_status)
    row.status_raw = raw_status
    row.screens = build_screens(by_target, row.status)

    for name, raw in by_target.items():
        if name in CORE_TARGETS or name in SHEET_ONLY_TARGETS or not raw:  # blank cells keep the defaults
            continue
        row.details[name] = _date(raw) if name == "source_date" else _typed(name, raw, row)
    for name in ("external_id", "store_name"):
        if not getattr(row, name):
            row.problems[name] = f"{FIELDS_BY_NAME[name].label} is required"
    return row


def dedupe_key_address(values: Mapping[str, Any]) -> str:
    """Normalised street|city|state|zip; "" when there is no street (such rows are never address duplicates)."""
    return normalized_address_key(dict(values)) if clean_cell(values.get("addr", "")) else ""


def mark_duplicates(rows: list[dict[str, Any]]) -> None:
    """Flag rows that repeat an earlier row of the same sheet: by IBC# first, then by normalised address
    (STORE-MODEL §1.4; venue code plays no part). Sets `duplicate_of` and `duplicate_reason` in place."""
    first_by_id: dict[str, int] = {}
    first_by_address: dict[str, int] = {}
    for row in sorted(rows, key=lambda item: item["index"]):
        external_id = normalize_external_id(row.get("external_id", ""))
        address = dedupe_key_address(row)
        if external_id and external_id in first_by_id:
            row.update(duplicate_of=first_by_id[external_id], duplicate_reason="external_id")
        elif address and address in first_by_address:
            row.update(duplicate_of=first_by_address[address], duplicate_reason="address")
        else:
            row.update(duplicate_of=None, duplicate_reason="")
            if external_id:
                first_by_id[external_id] = row["index"]
            if address:
                first_by_address[address] = row["index"]


def split_duplicates(existing: Iterable[Any], incoming: list[Any]) -> tuple[list[int], list[dict[str, Any]]]:
    """Which of `incoming` (submitted stops) to keep: a stop is skipped when its IBC# or, failing that, its
    normalised address matches a store already in the project or an earlier kept stop (STORE-MODEL §1.4).

    Returns (indexes to keep, skipped rows with `index`, `external_id`, `store_name`, `addr`, `reason`)."""
    known_ids: set[str] = set()
    known_addresses: set[str] = set()
    def address_of(stop: Any) -> str:
        return dedupe_key_address({"addr": stop.addr, "city": stop.city, "state": stop.state, "zip": stop.zip})

    for stop in existing:
        if stop.external_id:
            known_ids.add(normalize_external_id(stop.external_id))
        if address := address_of(stop):
            known_addresses.add(address)
    keep: list[int] = []
    skipped: list[dict[str, Any]] = []
    for index, stop in enumerate(incoming):
        external_id = normalize_external_id(stop.external_id)
        address = address_of(stop)
        reason = "external_id" if external_id and external_id in known_ids else (
            "address" if address and address in known_addresses else ""
        )
        if reason:
            skipped.append({"index": index, "external_id": external_id, "store_name": stop.store_name,
                            "addr": stop.addr, "reason": reason})
            continue
        keep.append(index)
        if external_id:
            known_ids.add(external_id)
        if address:
            known_addresses.add(address)
    return keep, skipped


ADDRESS_LINE_RE = re.compile(r"\s+")


def geocode_query(row: MappedRow) -> str:
    """What to send to Google: the split address when we have it, else the raw cell."""
    parts = [row.addr, row.city, " ".join(filter(None, [row.state, row.zip]))]
    line = ", ".join(part for part in parts if part)
    return ADDRESS_LINE_RE.sub(" ", line or row.address).strip()
