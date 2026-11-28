"""Find a store to log a visit to, across every project: by a screen's DD code (or stick number), or by the store's
own words (name, ExtID, street, city, state, ZIP). Pure.

One search box does both. A DD code is compared as `venue_code_key` does, with the separators dropped too, so
`dd-abc123`, `DD_ABC123`, `DD ABC123` and a part such as `ABC12` all find `DD_ABC123`. The store's words go through
the Stores search's matcher (`domain/search.py`), so "12 Main Street" finds "12 Main St".
"""
from __future__ import annotations

import re
from enum import StrEnum
from typing import Any

from dolphin_tracker.domain.base import ApiModel
from dolphin_tracker.domain.device import split_codes, venue_code_key
from dolphin_tracker.domain.search import matches, search_text

MIN_QUERY = 2  # fewer characters than this find nothing
MIN_CODE = 3  # a code search needs this many letters and digits beyond the "DD" prefix's own


class MatchKind(StrEnum):
    DD_CODE = "dd_code"  # a screen's DD code
    STICK = "stick_number"  # a screen's stick number
    STORE = "store"  # the store's name, ExtID or address


class VisitSearchScreen(ApiModel):
    id: str
    stick_number: str = ""
    venue_id: str = ""  # the DD code, as written on the screen
    status: str = ""


class VisitSearchRow(ApiModel):
    """A store a visit may be logged to, and why it matched."""

    project_id: str
    project_name: str
    uid: str
    display_id: str = ""
    external_id: str = ""
    store_name: str = ""
    addr: str = ""
    city: str = ""
    state: str = ""
    zip: str = ""
    status: str = ""
    screens: list[VisitSearchScreen]
    matched_on: list[MatchKind]
    matched_screen_ids: list[str]  # the screens whose DD code or stick number matched


class VisitSearchResult(ApiModel):
    items: list[VisitSearchRow]
    total: int  # every match; `items` holds the best `limit` of them


def _compact(value: object) -> str:
    """A code with every separator dropped: `DD_ABC-123` → `DDABC123`."""
    return re.sub(r"[^A-Z0-9]", "", venue_code_key(value))


def code_needle(query: str) -> str:
    """The query as a code to look for, or "" when it cannot be one (several words, or too short to mean
    anything: "dd" alone would match every screen)."""
    if len(query.split()) > 2:  # "DD ABC123" is a code typed with a space; "12 Main St" is not
        return ""
    needle = _compact(query)
    bare = needle[2:] if needle.startswith("DD") else needle
    wanted = len(bare) >= MIN_CODE and bool(re.search(r"\d", needle)) or len(bare) >= MIN_CODE + 2
    return needle if wanted else ""


def code_matches(needle: str, value: object) -> tuple[bool, bool]:
    """(matched, exactly) of one cell of codes against the needle."""
    found = exact = False
    for code in split_codes(value):
        compact = _compact(code)
        if needle and needle in compact:
            found = True
            exact = exact or needle == compact
    return found, exact


def store_words(item: dict[str, Any]) -> str:
    return search_text(item.get(key) for key in (
        "store_name", "external_id", "display_id", "addr", "city", "state", "zip",
    ))


def match_store(query: str, needle: str, item: dict[str, Any]) -> tuple[list[MatchKind], list[str], int] | None:
    """Why a store (a projected item) matches: what it matched on, the screens that did, and a rank (lower is
    better: an exact code, then part of a code, then the store's words). None when it does not match."""
    kinds: list[MatchKind] = []
    screen_ids: list[str] = []
    rank = 3
    for screen in item.get("screens") or []:
        for kind, key in ((MatchKind.DD_CODE, "venue_id"), (MatchKind.STICK, "stick_number")):
            found, exact = code_matches(needle, screen.get(key))
            if not found:
                continue
            rank = min(rank, 0 if exact else 1)
            if kind not in kinds:
                kinds.append(kind)
            if screen.get("id") and screen["id"] not in screen_ids:
                screen_ids.append(str(screen["id"]))
    if matches(query, store_words(item)):
        kinds.append(MatchKind.STORE)
        rank = min(rank, 2)
    return (kinds, screen_ids, rank) if kinds else None


def to_row(project_id: str, project_name: str, item: dict[str, Any], kinds: list[MatchKind],
           screen_ids: list[str]) -> VisitSearchRow:
    return VisitSearchRow(
        project_id=project_id,
        project_name=project_name,
        uid=item["uid"],
        display_id=item.get("display_id") or "",
        external_id=item.get("external_id") or "",
        store_name=item.get("store_name") or "",
        addr=item.get("addr") or "",
        city=item.get("city") or "",
        state=item.get("state") or "",
        zip=item.get("zip") or "",
        status=item.get("status") or "",
        screens=[
            VisitSearchScreen(
                id=str(screen.get("id") or ""), stick_number=screen.get("stick_number") or "",
                venue_id=screen.get("venue_id") or "", status=screen.get("status") or "",
            )
            for screen in item.get("screens") or []
        ],
        matched_on=kinds,
        matched_screen_ids=screen_ids,
    )
