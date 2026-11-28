"""Store use cases: listing (filter, search, sort, paginate), facets, map pins, CSV export, detail, screen and
progress edits.

Listing semantics (AGENT-HANDOFF §4.3, decided in §8): a project holds at most ~1000 stops, so every list call
loads the whole project once (`list_all`), filters and searches in Python, sorts, and pages with an offset cursor
(`encode_cursor({"offset": n})`). The API contract stays paginated, and free-text search works, which DynamoDB
filter expressions cannot do.
"""
from __future__ import annotations

import csv
import io
import re
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, field, replace
from typing import Any

from dolphin_tracker.domain.addresses import parse_us_formatted_address
from dolphin_tracker.domain.base import ApiModel
from dolphin_tracker.domain.cursors import encode_cursor, offset_from_cursor
from dolphin_tracker.domain.device import split_codes, venue_code_key
from dolphin_tracker.domain.device_sync import packed_screens, shown_location, store_with_code
from dolphin_tracker.domain.errors import ConflictError, NotFoundError, ValidationFailed
from dolphin_tracker.domain.import_mapping import clean_mapping, dedupe_key_address, single_pa, split_duplicates
from dolphin_tracker.domain.lists import best_spellings, name_key
from dolphin_tracker.domain.models import (
    PENDING_STATUSES,
    PROGRESS_FIELDS,
    STATUS_PRECEDENCE,
    NeedsAttention,
    Project,
    RoutingStatus,
    Screen,
    ScreenInput,
    ScreenStatus,
    Stop,
    StopInput,
    attention_of,
    now_iso,
)
from dolphin_tracker.domain.parsing import clean_cell
from dolphin_tracker.domain.route_optimizer import haversine, state_key
from dolphin_tracker.domain.schema import coerce_fields, validate_fields, validate_stop_inputs, with_sheet_fields
from dolphin_tracker.domain.search import matches, search_text
from dolphin_tracker.domain.statuses import (
    BUCKET_OF,
    BUCKET_ORDER,
    INSTALLED_STATUSES,
    StatusBucket,
    dolphin_model_key,
    screen_size_label,
    store_bucket_of,
)
from dolphin_tracker.domain.store_counts import (  # re-exported: callers import the mount helpers from here
    MOUNT_KINDS as MOUNT_KINDS,
)
from dolphin_tracker.domain.store_counts import (
    committed_screens,
    installed_screens,
    mismatch_ignored,
    mount_kind,
    mounts_needed,
    screen_mismatch,
)
from dolphin_tracker.domain.tags import clean_tag, tag_problem
from dolphin_tracker.domain.validation import (
    EDITABLE_FIELDS,
    FIELDS_BY_NAME,
    STORE_FIELDS,
    Kind,
    StoreField,
    normalize_external_id,
    stop_details,
    validate_store_values,
)
from dolphin_tracker.domain.visits import VisitState, visit_state
from dolphin_tracker.repositories.projects import ProjectRepository
from dolphin_tracker.repositories.stores import StoreRepository, screens_write
from dolphin_tracker.services.geocoding import Geocoder, resolve_address
from dolphin_tracker.services.routing import sync_routing_slot

FILTER_FIELDS = (
    "status", "bucket", "installer", "pa", "state", "city", "dma", "venue_type", "dd_code", "screen_size", "route",
    "visit", "install_type", "mount", "fulfilled", "technician", "review",
    # Committed > installed ("Yes" / "No") and the manager's tag.
    "committed_over_installed", "tag",
)
# The store's worked-out numbers, each filtered by a comparison ("Screens committed > 2"), not picked from a list.
NUMBER_FILTERS = ("screens_committed", "screens_installed", "mounts_needed", "mounts_installed")
YES, NO = "Yes", "No"
# The date-range filters on the screens' device data: each is a `<name>_from` / `<name>_to` pair on the query.
REGISTRATION_RANGES = ("first_registered", "last_registered")
NEEDS_MOUNT, NO_MOUNT_NEEDED = "Needs mount", "No mount needed"
FULFILLED, NOT_FULFILLED, NO_COMMITMENT = "Fulfilled", "Not fulfilled", "No commitment"
# Reads as done (Completed or Offline) but has fewer screen rows than the sheet committed.
NEEDS_REVIEW = "Needs review"
# The same mismatch, ignored by someone for the store's current numbers (it no longer counts as Needs review).
MISMATCH_IGNORED = "Mismatch ignored"
# The Projects-view overlays (ROUTE-PLANNER §6) as filter values.
IN_ROUTE, NOT_IN_ROUTE = "In route", "Not in route"
HAS_REVIEW_NOTES, NO_REVIEW_NOTES = "Has review notes", "No review notes"
VISIT_LABELS = {VisitState.VISITED: "Visited", VisitState.PARTLY: "Partly visited", VisitState.NONE: "Not visited"}
OVERLAY_ORDER = {
    value: index
    for index, value in enumerate([
        IN_ROUTE, NOT_IN_ROUTE, *VISIT_LABELS.values(), NEEDS_MOUNT, NO_MOUNT_NEEDED, FULFILLED, NEEDS_REVIEW,
        MISMATCH_IGNORED, NOT_FULFILLED,
        NO_COMMITMENT, HAS_REVIEW_NOTES, NO_REVIEW_NOTES, YES, NO,
        *(bucket.value for bucket in BUCKET_ORDER), StatusBucket.IN_PROGRESS.value,
    ])
}
SORT_KEYS = frozenset(
    {"store_name", "addr", "status", "installer", "installer_name", "day", "updated_at", "display_id", "screens", "tag",
     "distance"}  # distance: only with the Nearby filter
    | {spec.name for spec in STORE_FIELDS if spec.kind not in (Kind.TRISTATE, Kind.BOOL)}
)
ADDRESS_PARTS = ("addr", "city", "state", "zip")
TEXT_KINDS = frozenset({Kind.TEXT, Kind.MULTILINE, Kind.PHONE, Kind.EMAIL, Kind.URL, Kind.SELECT})
CSV_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")
# The search box finds a store by its ExtID, name or address; DMA, venue type, DD code and the rest have filters.
SEARCHED = ("display_id", "external_id", "store_name", "addr", "city", "state", "zip")


class StorePage(ApiModel):
    """A page of the store list, with the filtered total and where the page starts."""

    items: list[Stop]
    next_cursor: str | None = None
    total: int
    offset: int
    # Miles from the Nearby point per store uid on this page; only while that filter is on (None otherwise).
    distances: dict[str, float] | None = None


class ScreenListRow(ApiModel):
    """One screen in the Screens view: the screen itself, with the store it is at."""

    uid: str  # the store's
    external_id: str
    display_id: str
    store_name: str  # as shown: the Dolphin data's when it has one
    addr: str
    city: str  # as shown (place_city / place_state)
    state: str
    installer_name: str
    install_type: str
    screen: Screen


class ScreenPage(ApiModel):
    """A page of the screen list, with the filtered total and where the page starts."""

    items: list[ScreenListRow]
    total: int
    offset: int


# Filters that are about a screen: in the Screens view they keep the screens they match, not whole stores.
SCREEN_FILTERS = ("status", "bucket", "dd_code", "screen_size")
SCREEN_SORT_KEYS = frozenset({"venue_id", "status", "screen_size", "owner", "brand"})


def _screen_matches(screen: Screen, query: StoreQuery) -> bool:
    if query.status and screen.status not in query.status:
        return False
    # The store groups say "In Progress" where a screen says "Not Registered": either name finds the screen.
    if query.bucket and not {BUCKET_OF[screen.status], store_bucket_of(screen.status)}.intersection(query.bucket):
        return False
    if query.dd_code and screen.venue_id not in query.dd_code:
        return False
    return not query.screen_size or screen.screen_size in query.screen_size


def _screen_sort_value(screen: Screen, sort: str) -> Any:
    match sort:
        case "status":
            return (0, STATUS_PRECEDENCE.index(screen.status))
        case "owner":
            return (0, 0 if screen.is_dolphin_screen else 1)
        case "screen_size":
            digits = re.sub(r"\D", "", screen.screen_size)
            return (0, int(digits)) if digits else None
        case "brand":
            return (1, screen.screen_type.lower()) if screen.screen_type else None
        case _:
            return (1, _natural(screen.venue_id)) if screen.venue_id else None


@dataclass(frozen=True)
class Bounds:
    north: float
    south: float
    east: float
    west: float


def in_bounds(stop: Stop, bounds: Bounds) -> bool:
    lat, lng = shown_location(stop)  # where the map draws it: the device report's location when it has one
    if lat is None or lng is None:
        return False
    return bounds.south <= lat <= bounds.north and bounds.west <= lng <= bounds.east


@dataclass(frozen=True)
class Near:
    """The Nearby filter: stores within `radius_miles` (great-circle) of a point."""

    lat: float
    lng: float
    radius_miles: float


def distance_miles(stop: Stop, near: Near) -> float | None:
    """Miles from the Nearby point to where the map draws the store; None when it has no location."""
    lat, lng = shown_location(stop)
    if lat is None or lng is None:
        return None
    return haversine(near.lat, near.lng, lat, lng)


def registered_between(stop: Stop, which: str, start: str, end: str) -> bool:
    """Any of the store's screens first (or last) registered on a day from `start` to `end` (YYYY-MM-DD, either may be
    "", both inclusive). The device data's timestamps are ISO UTC, so their first ten characters are the UTC day."""
    for screen in stop.screens:
        day = (getattr(screen.device, which) if screen.device else "")[:10]
        if day and (not start or day >= start) and (not end or day <= end):
            return True
    return False


@dataclass(frozen=True)
class Comparison:
    """A number filter: the store's number higher than (`gt`), lower than (`lt`) or equal to (`eq`) `value`."""

    op: str
    value: int

    def matches(self, number: int) -> bool:
        if self.op == "gt":
            return number > self.value
        if self.op == "lt":
            return number < self.value
        return number == self.value


COMPARISON_PATTERN = r"^(gt|lt|eq):\d{1,6}$"


def parse_comparison(text: str | None) -> Comparison | None:
    """`gt:2` → Comparison("gt", 2); None or "" → no filter. The router has checked the shape already."""
    if not text:
        return None
    op, _, value = text.partition(":")
    return Comparison(op, int(value))


def number_value(stop: Stop, name: str) -> int:
    """The number a number filter compares: committed Dolphin screens + store TVs, screen rows on the wall, mounts
    to bring, mounts used (typed-over or worked out). A blank count is 0."""
    match name:
        case "screens_committed":
            return stop.committed_screens_total
        case "screens_installed":
            return stop.installed_screens_total
        case "mounts_needed":
            return stop.effective_mounts_needed_total
        case _:
            return stop.effective_mounts_used


@dataclass
class StoreQuery:
    """Filters (STORE-MODEL §5), search and sort. Within one filter values are OR'ed; filters are AND'ed."""

    status: list[ScreenStatus] = field(default_factory=list)
    installer: list[str] = field(default_factory=list)  # "" matches unassigned stops
    pa: list[str] = field(default_factory=list)
    state: list[str] = field(default_factory=list)
    city: list[str] = field(default_factory=list)
    dma: list[str] = field(default_factory=list)
    venue_type: list[str] = field(default_factory=list)
    dd_code: list[str] = field(default_factory=list)  # any screen's venue_id
    screen_size: list[str] = field(default_factory=list)  # any screen's size
    route: list[str] = field(default_factory=list)  # "In route" / "Not in route"
    visit: list[str] = field(default_factory=list)  # "Visited" / "Partly visited" / "Not visited"
    bucket: list[StatusBucket] = field(default_factory=list)  # the store's status group (Completed, In Progress…)
    install_type: list[str] = field(default_factory=list)  # Technician / Self install / Rep install
    technician: list[str] = field(default_factory=list)  # the store's technician (installer_name); "" = none
    mount: list[str] = field(default_factory=list)  # "Needs mount" / "No mount needed"
    fulfilled: list[str] = field(default_factory=list)  # "Fulfilled" / "Not fulfilled" / "No commitment"
    review: list[str] = field(default_factory=list)  # "Has review notes" / "No review notes"
    # The number filters (`number_value`); None = off.
    screens_committed: Comparison | None = None
    screens_installed: Comparison | None = None
    mounts_needed: Comparison | None = None
    mounts_installed: Comparison | None = None
    committed_over_installed: list[str] = field(default_factory=list)  # "Yes" / "No": committed > installed
    tag: list[str] = field(default_factory=list)  # one of the project's tags; "" = no tag
    # Registration days (YYYY-MM-DD, inclusive, "" = open end) of any screen, from the device data.
    first_registered_from: str = ""
    first_registered_to: str = ""
    last_registered_from: str = ""
    last_registered_to: str = ""
    near: Near | None = None
    needs_attention: bool = False  # only stores added without a name or a verified address
    q: str = ""
    sort: str = "store_name"
    dir: str = "asc"

    def without(self, name: str) -> StoreQuery:
        """The same query with one filter cleared (facet counts, the top-states chart)."""
        return replace(self, **{name: []})


def pa_values(stop: Stop, project: Project) -> list[str]:
    """A store's PA(s): its own when the sheet had a PA column, else the project's (STORE-MODEL §1.3)."""
    return [part.strip() for part in (stop.pa or project.pa).split(",") if part.strip()]


def facet_values(stop: Stop, project: Project, name: str) -> list[str]:
    """The value(s) a store has for one filter; "" counts as a value only for the installer and technician
    (unassigned)."""
    match name:
        case "status":
            return [stop.status.value]
        case "installer":
            return [stop.installer]
        case "technician":  # who is assigned to install (the sheet's Technician column); "" = nobody yet
            return [stop.installer_name]
        case "pa":
            return pa_values(stop, project)
        case "dd_code":
            return [screen.venue_id for screen in stop.screens if screen.venue_id]
        case "screen_size":
            return [screen.screen_size for screen in stop.screens if screen.screen_size]
        case "route":
            return [IN_ROUTE if stop.route_plan_id else NOT_IN_ROUTE]
        case "visit":
            return [VISIT_LABELS[stop_visit_state(stop)]]
        case "bucket":
            return [store_bucket_of(stop.status).value]
        case "mount":
            return [NEEDS_MOUNT if needs_mount(stop) else NO_MOUNT_NEEDED]
        case "fulfilled":
            return [fulfillment(stop)]
        case "review":
            return [HAS_REVIEW_NOTES if stop.review_notes.strip() else NO_REVIEW_NOTES]
        case "committed_over_installed":  # literally fewer installed than committed, mismatch ignored or not
            return [YES if stop.committed_screens_total > stop.installed_screens_total else NO]
        case "tag":
            return [stop.tag]
        case "state":  # as shown: the Dolphin data's or the verified address's, never a typed spelling
            return [stop.place_state] if stop.place_state else []
        case "city":
            return [stop.place_city] if stop.place_city else []
        case "dma":  # as shown: the Dolphin data's over the sheet's
            dma = (stop.device.dma if stop.device else "") or stop.dma
            return [dma] if dma else []
        case _:
            value = getattr(stop, name)
            return [value] if value else []


DEFAULT_SIZE = '24"'  # a screen saved without a size


def needs_mount(stop: Stop) -> bool:
    """Mounts still to bring (typed, or worked out from the Upcoming screens), or a screen flagged before those
    existed. The TV mount count is no longer shown or counted."""
    return any(mounts_needed(stop).values()) or any(screen.needs_mount for screen in stop.screens)


def fulfillment(stop: Stop) -> str:
    """Fulfilled once the screen rows on the wall (Completed, Offline, Needs More Work) reach the committed Dolphin
    screens + store TVs. A blank committed count is 0: a store with something installed and no count is fulfilled,
    and it is "No commitment" only when it has neither. A done store short of screen rows is "Needs review", or
    "Mismatch ignored" once someone ignored that for its current numbers."""
    committed = committed_screens(stop)
    installed = installed_screens(stop)
    if committed == 0:  # a blank count is 0: anything installed meets it
        return FULFILLED if installed else NO_COMMITMENT
    if screen_mismatch(stop):
        return MISMATCH_IGNORED if mismatch_ignored(stop) else NEEDS_REVIEW
    return FULFILLED if installed >= committed else NOT_FULFILLED


def stop_visit_state(stop: Stop) -> VisitState:
    """Every stick visited since the store's latest plan (ROUTE-PLANNER §6)."""
    return visit_state([screen.id for screen in stop.screens], stop.screen_visits, stop.last_planned_at)


def _natural(value: str) -> tuple:
    """'S10' after 'S9'."""
    return tuple(int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", value))


def _sort_value(stop: Stop, sort: str) -> Any:
    if sort.startswith("fields."):
        value = stop.fields.get(sort.removeprefix("fields."))
    elif sort == "screens":
        value = len(stop.screens)
    elif sort in ("city", "state"):
        value = stop.place_city if sort == "city" else stop.place_state
    else:
        value = getattr(stop, sort)
    if value is None or value == "":
        return None
    if sort in ("display_id", "external_id"):
        return (1, _natural(value))
    if sort == "status":
        return (0, STATUS_PRECEDENCE.index(value))  # least progressed first
    if isinstance(value, bool):
        return (0, int(value))
    if isinstance(value, (int, float)):
        return (0, value)
    return (1, str(value).lower())


def _matches(stop: Stop, needle: str) -> bool:
    """ExtID, store name and address: the sheet's, Google's verified one, and the device report's (with its store
    and CMS names). Every word typed must be in there somewhere (`domain/search.py`), so a whole address matches
    across the street, city, state and ZIP fields. DD codes are not searched: they have a filter of their own."""
    parts: list[object] = [getattr(stop, name) for name in SEARCHED]
    parts.append(stop.geocoded)
    if stop.device:
        parts.extend([stop.device.store_name, stop.device.venue_name, stop.device.address])
    return matches(needle, search_text(parts))


def _csv_cell(value: Any) -> Any:
    """Neutralise spreadsheet formulas (CSV injection) in exported text cells."""
    if isinstance(value, str) and value.startswith(CSV_FORMULA_PREFIXES):
        return "'" + value
    return value


def _csv_value(spec: StoreField, value: Any) -> Any:
    if spec.kind == Kind.TRISTATE:
        return "" if value is None else ("yes" if value else "no")
    if spec.kind == Kind.BOOL:
        return "yes" if value else "no"
    return "" if value is None else value


def screen_summary(screen: Screen) -> str:
    """One screen row for the CSV: stick / DD code / size / kind / mount / status."""
    kind = "Dolphin screen" if screen.is_dolphin_screen else "Store TV"
    if screen.screen_type:
        kind += f" ({screen.screen_type})"
    mount = f"{'ceiling' if screen.has_ceiling_mount else 'wall'} mount{'' if screen.has_mount else ' (none yet)'}"
    if screen.needs_mount:
        mount += ", needs mount"
    parts = [screen.stick_number or "—", screen.venue_id or "—", screen.screen_size or "—", kind, mount]
    return " / ".join([*parts, screen.status.value])


class StoreService:
    def __init__(
        self,
        stores: StoreRepository,
        projects: ProjectRepository | None = None,
        geocoder: Geocoder | None = None,
    ) -> None:
        self._stores = stores
        self._projects = projects
        self._geocoder = geocoder

    def _project(self, project_id: str) -> Project:
        assert self._projects is not None
        project = self._projects.get(project_id)
        if project is None:
            raise NotFoundError(f"Project {project_id} not found")
        return project

    # ---- reads --------------------------------------------------------------------------------------------

    def _filter(self, project: Project, stops: list[Stop], query: StoreQuery) -> list[Stop]:
        for name in FILTER_FIELDS:
            wanted = {str(value) for value in getattr(query, name)}
            if wanted and name == "technician":  # a name matches whatever case it was typed in
                keys = {name_key(value) for value in wanted}
                stops = [stop for stop in stops if name_key(stop.installer_name) in keys]
            elif wanted:
                stops = [stop for stop in stops if wanted.intersection(facet_values(stop, project, name))]
        for name in NUMBER_FILTERS:
            comparison: Comparison | None = getattr(query, name)
            if comparison is not None:
                stops = [stop for stop in stops if comparison.matches(number_value(stop, name))]
        needle = query.q.strip().lower()
        if needle:
            stops = [stop for stop in stops if _matches(stop, needle)]
        if query.needs_attention:
            stops = [stop for stop in stops if stop.needs_attention]
        for which in REGISTRATION_RANGES:
            start, end = getattr(query, f"{which}_from"), getattr(query, f"{which}_to")
            if start or end:
                stops = [stop for stop in stops if registered_between(stop, which, start, end)]
        if query.near is not None:
            near = query.near
            stops = [
                stop for stop in stops
                if (miles := distance_miles(stop, near)) is not None and miles <= near.radius_miles
            ]
        return stops

    def _query(self, project: Project, query: StoreQuery, stops: list[Stop] | None = None) -> list[Stop]:
        sort = query.sort or "store_name"
        if sort not in SORT_KEYS and not sort.startswith("fields."):
            raise ValueError(f"Unknown sort {sort!r}")
        if sort.startswith("fields.") and sort.removeprefix("fields.") not in {f.key for f in project.field_schema}:
            raise ValueError(f"Unknown sort field {sort!r}")
        if query.dir not in ("asc", "desc"):
            raise ValueError("dir must be asc or desc")
        near = query.near
        if sort == "distance" and near is None:
            raise ValueError("Sort by distance needs near_lat, near_lng and radius_miles")
        stops = self._filter(project, self._stores.list_all(project.id) if stops is None else stops, query)

        def value(stop: Stop) -> Any:
            if sort == "distance" and near is not None:
                miles = distance_miles(stop, near)
                return None if miles is None else (0, miles)
            return _sort_value(stop, sort)

        # Stable two-step sort: a deterministic tie-break first, then the requested key; blanks always last.
        stops.sort(key=lambda stop: (_natural(stop.display_id), stop.uid))
        present = [stop for stop in stops if value(stop) is not None]
        blank = [stop for stop in stops if value(stop) is None]
        present.sort(key=value, reverse=query.dir == "desc")
        return present + blank

    def list(
        self,
        project_id: str,
        query: StoreQuery | None = None,
        *,
        limit: int = 50,
        cursor: str | None = None,
        offset: int | None = None,
        bounds: Bounds | None = None,
    ) -> StorePage:
        """One page of the filtered, sorted stores, with the total so the table can page by number. `offset` jumps
        straight to a page (a `cursor` wins when both are given); `bounds` keeps only stores inside the map view."""
        project = self._project(project_id)
        start = offset_from_cursor(cursor) if cursor else (offset or 0)
        stops = self._query(project, query or StoreQuery())
        if bounds is not None:
            stops = [stop for stop in stops if in_bounds(stop, bounds)]
        window = stops[start : start + limit]
        next_cursor = encode_cursor({"offset": start + limit}) if start + limit < len(stops) else None
        near = (query or StoreQuery()).near
        distances = None
        if near is not None:  # every store the filter kept has a location
            distances = {stop.uid: round(distance_miles(stop, near) or 0.0, 2) for stop in window}
        return StorePage(items=window, next_cursor=next_cursor, total=len(stops), offset=start, distances=distances)

    def screens(
        self,
        project_id: str,
        query: StoreQuery | None = None,
        *,
        limit: int = 50,
        offset: int = 0,
        bounds: Bounds | None = None,
    ) -> ScreenPage:
        """One page of screens, one row each (the Screens view). The store filters pick the stores; the filters about
        a screen (status, group, DD code, size) pick the screens themselves, so "Offline" lists offline screens, not
        every screen of a store that reads Offline. Sorted by a store column, or by one of the screen's own."""
        project = self._project(project_id)
        query = query or StoreQuery()
        by_screen = query.sort in SCREEN_SORT_KEYS
        stores = replace(query, **dict.fromkeys(SCREEN_FILTERS, []), sort="store_name" if by_screen else query.sort,
                         dir="asc" if by_screen else query.dir)
        stops = self._query(project, stores)
        if bounds is not None:
            stops = [stop for stop in stops if in_bounds(stop, bounds)]
        rows = [(stop, screen) for stop in stops for screen in stop.screens if _screen_matches(screen, query)]
        if by_screen:
            present = [row for row in rows if _screen_sort_value(row[1], query.sort) is not None]
            blank = [row for row in rows if _screen_sort_value(row[1], query.sort) is None]
            present.sort(key=lambda row: _screen_sort_value(row[1], query.sort), reverse=query.dir == "desc")
            rows = present + blank
        items = [
            ScreenListRow(
                uid=stop.uid, external_id=stop.external_id, display_id=stop.display_id,
                store_name=(stop.device.store_name if stop.device else "") or stop.store_name,
                addr=stop.addr, city=stop.place_city, state=stop.place_state,
                installer_name=stop.installer_name, install_type=stop.install_type or "", screen=screen,
            )
            for stop, screen in rows[offset : offset + limit]
        ]
        return ScreenPage(items=items, total=len(rows), offset=offset)

    def get(self, project_id: str, stop_uid: str) -> Stop:
        self._project(project_id)
        stop = self._stores.get(project_id, stop_uid)
        if stop is None:
            raise NotFoundError(f"Stop {stop_uid} not found")
        return stop

    def overview(
        self, project_id: str, query: StoreQuery | None = None, *, pending: bool = True, limit: int = 10,
        unit: str = "stores",
    ) -> dict[str, Any]:
        """Everything beside the table on the Stores page, from one read of the project's stores: the map pins, the
        filter options, the top states and the hardware counts. Each is exactly what its own endpoint returns; asked
        for separately they would each read (and parse) every store again, on a Lambda of their own."""
        query = query or StoreQuery()
        stops = self._stores.list_all(project_id)
        return {
            "pins": self.pins(project_id, query, stops=stops),
            "filters": self.filters(project_id, query, stops=stops),
            "by_state": self.by_state(project_id, query, pending=pending, limit=limit, unit=unit, stops=stops),
            "hardware": self.hardware(project_id, query, stops=stops),
        }

    def pins(
        self, project_id: str, query: StoreQuery | None = None, *, stops: list[Stop] | None = None
    ) -> list[dict[str, Any]]:
        """Whole-project map payload, located stops only (deliberately unpaginated, rule 4). `stops`: the project's
        stores when the caller has just read them (`overview`)."""
        project = self._project(project_id)
        mine = None if stops is None else list(stops)  # `_query` sorts in place
        located = [(stop, *shown_location(stop)) for stop in self._query(project, query or StoreQuery(), mine)]
        return [
            {
                "uid": stop.uid,
                "lat": lat,
                "lng": lng,
                "status": stop.status,
                "store_name": stop.store_name,
                "installer": stop.installer,
                "day": stop.day,
                "route_plan_id": stop.route_plan_id,
                "visit_state": stop_visit_state(stop),
                "screen_statuses": [screen.status for screen in stop.screens],
                "display_id": stop.external_id or stop.display_id,
                "addr": stop.addr,
                "city": stop.place_city,
                "state": stop.place_state,
                "zip": stop.zip,
            }
            for stop, lat, lng in located
            if lat is not None and lng is not None
        ]

    def filters(
        self, project_id: str, query: StoreQuery | None = None, *, stops: list[Stop] | None = None
    ) -> dict[str, list[dict[str, Any]]]:
        """Distinct values per filter with store counts, for the filter bar (STORE-MODEL §5).

        Each filter's options are counted over the stores matching every *other* active filter and the search,
        so e.g. the city list narrows to the chosen state. An empty list means the filter has no values (the UI
        greys it out). Statuses come in precedence order, other values alphabetically."""
        project = self._project(project_id)
        query = query or StoreQuery()
        everything = self._stores.list_all(project_id) if stops is None else stops
        result: dict[str, list[dict[str, Any]]] = {}
        for name in FILTER_FIELDS:
            counts: Counter[str] = Counter()
            for stop in self._filter(project, list(everything), query.without(name)):
                counts.update(set(facet_values(stop, project, name)))
            if name == "technician":  # one option per technician, in the spelling used most
                spelling = best_spellings(Counter(stop.installer_name for stop in everything))
                merged: Counter[str] = Counter()
                for value, count in counts.items():
                    merged[spelling.get(name_key(value), value)] += count
                counts = merged
            if name == "status":
                ordered = [status.value for status in STATUS_PRECEDENCE if counts[status.value]]
            elif name == "tag":  # every tag of the project (to pick one no store has yet), then stale ones, no tag last
                stale = sorted(value for value in counts if value and value not in project.tag_options)
                ordered = [*project.tag_options, *stale, *([""] if counts[""] else [])]
            elif name in ("route", "visit", "bucket", "mount", "fulfilled", "review", "committed_over_installed"):
                ordered = sorted(counts, key=lambda value: OVERLAY_ORDER[value])
            else:
                ordered = sorted(counts, key=lambda value: (value == "", _natural(value)))
            result[name] = [{"value": value, "count": counts[value]} for value in ordered]
        return result

    def by_state(
        self,
        project_id: str,
        query: StoreQuery | None = None,
        *,
        pending: bool = True,
        limit: int = 10,
        unit: str = "stores",
        stops: list[Stop] | None = None,
    ) -> list[dict[str, Any]]:
        """Stores or screens per state, most first (the "Top states by upcoming installs" chart): the active filters
        apply except State itself, so clicking a bar never empties the chart. `pending` keeps pending-status stores
        (or, counting screens, pending-status screens; a store without screen rows counts as one screen)."""
        if unit not in ("stores", "screens"):
            raise ValueError("unit must be stores or screens")
        project = self._project(project_id)
        everything = self._stores.list_all(project_id) if stops is None else stops
        stops = self._filter(project, everything, (query or StoreQuery()).without("state"))
        counts: Counter[str] = Counter()
        for stop in stops:
            state = stop.place_state
            if not state:
                continue
            if unit == "stores":
                counts[state] += int(not pending or stop.status in PENDING_STATUSES)
            else:
                statuses = [screen.status for screen in stop.screens] or [stop.status]
                counts[state] += sum(1 for status in statuses if not pending or status in PENDING_STATUSES)
        ranked = sorted(((s, c) for s, c in counts.items() if c), key=lambda item: (-item[1], item[0]))[:limit]
        return [{"state": state, "count": count} for state, count in ranked]

    def hardware(
        self, project_id: str, query: StoreQuery | None = None, *, stops: list[Stop] | None = None
    ) -> dict[str, Any]:
        """The installed hardware of the stores the filters keep (the "Hardware cost" chart): installed screens (a stick
        each) and installed Dolphin screens by model. Prices live on the project; the page multiplies."""
        project = self._project(project_id)
        everything = self._stores.list_all(project_id) if stops is None else stops
        stops = self._filter(project, everything, query or StoreQuery())
        by_model: dict[str, int] = {}
        # Screens with a mount chosen (not Cancelled or Archived): the 24 inch wall mount is its own piece.
        mounts = {"wall_24": 0, "wall_other": 0, "ceiling": 0}
        installed_mounts: dict[str, int] = {}  # on installed screens, by '24"|wall' / '43"|ceiling': what they cost
        screens = stores = 0
        for stop in stops:
            for screen in stop.screens:
                kind = mount_kind(screen)
                if kind and screen.status not in (ScreenStatus.CANCELLED, ScreenStatus.ARCHIVED):
                    mounts["wall_other" if kind == "wall" else kind] += 1
            installed = [screen for screen in stop.screens if screen.status in INSTALLED_STATUSES]
            stores += bool(installed)
            screens += len(installed)
            for screen in installed:
                if kind := mount_kind(screen):
                    size = screen_size_label(screen.screen_size) or DEFAULT_SIZE
                    piece = f"{size}|{'ceiling' if kind == 'ceiling' else 'wall'}"
                    installed_mounts[piece] = installed_mounts.get(piece, 0) + 1
                if screen.is_dolphin_screen:
                    model = dolphin_model_key(screen.screen_size, screen.screen_type)
                    by_model[model] = by_model.get(model, 0) + 1
        return {"installed_screens": screens, "installed_stores": stores, "installed_dolphin_by_model": by_model,
                "mounts": mounts, "installed_mounts": installed_mounts}

    def field_usage(self, project_id: str) -> dict[str, int]:
        """How many stores hold a non-empty value per `fields` key (Settings warns before a field is removed)."""
        self._project(project_id)
        counts: dict[str, int] = {}
        for row in self._stores.list_projected(project_id, ("fields",)):
            for key, value in (row.get("fields") or {}).items():
                if value not in (None, ""):
                    counts[key] = counts.get(key, 0) + 1
        return counts

    def export_csv(self, project_id: str, query: StoreQuery | None = None) -> str:
        """One row per store: the §2 fields in §3 order, the screens (count, actual counts, rows joined with
        "; "), routing, progress, then the project's extra fields. Same filters and order as the list."""
        project = self._project(project_id)
        schema = project.field_schema
        header = [
            "ID", *[spec.label for spec in STORE_FIELDS], "Lat", "Lng", "Status", "Screens",
            "Dolphin screens (actual)", "Store TVs (actual)", "Screen rows", "Installer", "Day", "Seq",
            "Completed by", "Notes", "Review notes", *[f.label for f in schema], "Updated by", "Updated at",
            # The store's worked-out (or typed-over) numbers and the manager's tag, as the table shows them.
            "Mounts needed (total)", "Mounts used (total)", "Tag", "Screen mismatch",
        ]
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(header)
        for stop in self._query(project, query or StoreQuery()):
            details = {spec.name: _csv_value(spec, getattr(stop, spec.name)) for spec in STORE_FIELDS}
            details["pa"] = details["pa"] or project.pa
            dolphin = sum(1 for screen in stop.screens if screen.is_dolphin_screen)
            row = [
                stop.display_id, *details.values(),
                "" if stop.lat is None else stop.lat, "" if stop.lng is None else stop.lng,
                stop.status.value, len(stop.screens), dolphin, len(stop.screens) - dolphin,
                "; ".join(screen_summary(screen) for screen in stop.screens),
                stop.installer, stop.day, stop.seq, stop.installer_name,
                stop.comment, stop.review_notes, *[stop.fields.get(f.key, "") for f in schema],
                stop.updated_by, stop.updated_at,
                stop.effective_mounts_needed_total, stop.effective_mounts_used, stop.tag,
                (MISMATCH_IGNORED.lower() if stop.mismatch_ignored else "yes") if stop.screen_mismatch else "no",
            ]
            writer.writerow([_csv_cell(value) for value in row])
        return buffer.getvalue()

    # ---- writes -------------------------------------------------------------------------------------------

    def update_details(self, project_id: str, stop_uid: str, changes: dict[str, Any]) -> Stop:
        """Edit the planner-editable store attributes (STORE-MODEL §2) and the project's extra fields. A changed
        address is geocoded first; partial or failed matches are refused with suggestions. The ExtID, PA, routing
        and progress attributes are never part of this write (the API model rejects them)."""
        project = self._project(project_id)
        current = self.get(project_id, stop_uid)
        changes = dict(changes)
        picked = changes.pop("place", None)  # a Google place the person chose: saved at its pin, no address check
        unknown = set(changes) - EDITABLE_FIELDS - {"fields"}
        if unknown:
            raise ValidationFailed(f"Not editable here: {', '.join(sorted(unknown))}", errors=sorted(unknown))

        update: dict[str, Any] = {}
        for name, value in changes.items():
            if name == "fields":
                continue
            spec = FIELDS_BY_NAME[name]
            update[name] = ("" if value is None else str(value).strip()) if spec.kind in TEXT_KINDS else value
        problems = validate_store_values(update, partial=True)
        fields = changes.get("fields") or {}
        errors = [*problems.values(), *validate_fields(project.field_schema, fields, partial=True)]
        if errors:
            raise ValidationFailed("; ".join(errors), errors=errors, fields=problems)

        address_changed = any(key in update and update[key] != getattr(current, key) for key in ADDRESS_PARTS)
        if address_changed or picked:
            assert self._geocoder is not None
            parts = [update.get(key, getattr(current, key)) for key in ADDRESS_PARTS]
            lookup = ", ".join(part for part in parts if part)
            if picked:
                formatted = picked.get("formatted") or lookup
                geo = {"ok": True, "lat": picked["lat"], "lng": picked["lng"], "formatted": formatted}
            else:
                geo = resolve_address(self._geocoder, lookup, update.get("store_name", current.store_name))
            if not geo.get("ok") or geo.get("partial"):
                raise ValidationFailed(
                    "Address could not be verified by Google. Pick a suggestion or correct the address.",
                    google_status=geo.get("status"),
                    suggestions=geo.get("suggestions") or [],
                )
            update.update(lat=geo.get("lat"), lng=geo.get("lng"), geocoded=geo.get("formatted") or lookup)
            update["route_stale"] = True  # the routes were built for the old location
        # A store added without a name or a verified address stops needing attention once that is fixed.
        attention = [
            reason for reason in current.needs_attention
            if not (reason == "store_name" and str(update.get("store_name", current.store_name)).strip())
            and not (reason == "address" and update.get("lat") is not None)
        ]
        if attention != list(current.needs_attention):
            update["needs_attention"] = [str(reason) for reason in attention]
        update = {
            key: value for key, value in update.items() if key not in EDITABLE_FIELDS or value != getattr(current, key)
        }  # unchanged values need no write

        for key, value in coerce_fields(project.field_schema, fields).items():
            update[f"fields.{key}"] = value  # one entry each, so concurrent edits to other fields survive
        if not update:
            return current
        return self._stores.update_fields(project_id, stop_uid, update)

    def update_screens(
        self, project_id: str, stop_uid: str, screens: list[ScreenInput], *, updated_by: str = "",
        stops: list[Stop] | None = None,
    ) -> Stop:
        """Replace a store's screen rows (full list, ≥ 1). Rows sent back with the id of one of this store's
        screens keep it; any other row gets a new server-minted id. The derived status follows. A DD code new to
        this store is refused when another store of the project already has it (`stops`: the project's stores when
        the caller has just read them)."""
        current = self.get(project_id, stop_uid)
        if not screens:
            raise ValidationFailed("A store needs at least one screen")
        had = {venue_code_key(code) for screen in current.screens for code in split_codes(screen.venue_id)}
        new_codes = [code for screen in screens for code in split_codes(screen.venue_id)
                     if venue_code_key(code) and venue_code_key(code) not in had]
        if new_codes:
            others = stops if stops is not None else self._stores.list_all(project_id)
            for code in new_codes:
                holder = store_with_code(code, others, exclude_uid=stop_uid)
                if holder is not None:
                    names = [part for part in (holder.store_name, holder.external_id) if part]
                    where = " · ".join(names) or "another store"
                    raise ValidationFailed(f"DD code {code} is already on {where}. A DD code belongs to one store.")
        known = {screen.id: screen for screen in current.screens}
        now = now_iso()
        rows = []
        for screen in screens:
            before = known.get(screen.id or "")
            row = screen.model_copy(update={
                "id": screen.id if before else None,
                # Left out: the pictures the screen has stay (a row new to the store has none).
                "pictures": screen.pictures if screen.pictures is not None else (before.pictures if before else []),
            }).to_screen()
            # The device report's values stay with the screen; a status change is stamped (device alert timing).
            changed = row.status != (before.status if before else ScreenStatus.UPCOMING)
            stamp = now if changed else (before.status_changed_at if before else "")
            rows.append(row.model_copy(update={
                "device": before.device if before else None, "status_changed_at": stamp,
            }))
        ids = [row.id for row in rows]
        if len(set(ids)) != len(ids):
            raise ValidationFailed("The same screen appears twice")
        if NeedsAttention.DD_CODE_REVIEW in current.needs_attention and not packed_screens(rows):
            # The person split the packed DD code entry: the store no longer needs that review.
            reasons = [str(r) for r in current.needs_attention if r != NeedsAttention.DD_CODE_REVIEW]
            changes = {**screens_write(rows, updated_by.strip()), "needs_attention": reasons}
            return self._stores.update_fields(project_id, stop_uid, changes)
        return self._stores.update_screens(project_id, stop_uid, rows, updated_by=updated_by.strip())

    def set_external_id(self, project_id: str, stop_uid: str, external_id: str) -> Stop:
        """Enter the ExtID of a store that has none (added from the Dolphin data). Once set it is fixed, like any
        ExtID; 409 if another store of the project has it."""
        current = self.get(project_id, stop_uid)
        if current.external_id:
            raise ConflictError("This store already has an ExtID; it cannot be changed")
        value = normalize_external_id(external_id)
        if not value:
            raise ValidationFailed("Enter the ExtID")
        reasons = [str(r) for r in current.needs_attention if r != NeedsAttention.EXTERNAL_ID]
        return self._stores.set_external_id(project_id, stop_uid, value, reasons)

    def set_tag(self, project_id: str, stop_uid: str, tag: str) -> Stop:
        """Set a store's tag to one of the project's options, or clear it with "". A tag removed from the options
        stays on the stores that carry it until someone changes it."""
        project = self._project(project_id)
        current = self.get(project_id, stop_uid)
        value = clean_tag(tag)
        problem = tag_problem(value, project.tag_options, current.tag)
        if problem:
            raise ValidationFailed(problem, errors=[problem], fields={"tag": problem})
        if value == current.tag:
            return current
        return self._stores.update_fields(project_id, stop_uid, {"tag": value})

    def update_progress(self, project_id: str, stop_uid: str, changes: dict[str, Any]) -> Stop:
        """Comment / review notes / additional task / installer name / updated_by. Status is per screen
        (`update_screens`). `ignore_mismatch` True remembers the store's current committed total and screen rows
        (only while they mismatch); False forgets the ignore."""
        current = self.get(project_id, stop_uid)
        changes = dict(changes)
        ignore = changes.pop("ignore_mismatch", None)
        update = {key: value for key, value in changes.items() if value is not None}
        if ignore is True:
            if not screen_mismatch(current):
                raise ValidationFailed("This store has no screen mismatch to ignore")
            update["mismatch_ignore"] = {"committed": committed_screens(current), "rows": len(current.screens)}
        elif ignore is False:
            update["mismatch_ignore"] = None
        extra = set(update) - (PROGRESS_FIELDS - {"screens", "status"})
        if extra:
            raise ValueError(f"Not progress fields: {sorted(extra)}")
        if not update:
            raise ValidationFailed("Nothing to update")
        return self._stores.update_fields(project_id, stop_uid, update)

    # ---- append -------------------------------------------------------------------------------------------

    def append(
        self, project_id: str, stops: list[StopInput], pa: str = "", import_mapping: dict[str, str] | None = None
    ) -> dict[str, Any]:
        """Add stops without re-routing (v1 `append_project_stops`): skip duplicates by venue code or normalised
        address, then place each new stop greedily on the installer with the fewest stops, on a same-state day
        with room, else on a new day. Synchronous: no optimizer run."""
        project = self._project(project_id)
        if project.routing_status == RoutingStatus.BUILDING:
            raise ConflictError("Routing is in progress; append once it finishes")
        assert self._projects is not None
        # Hold the slot for the whole append: a build enqueued after the check above gets a 409 instead of
        # computing over the old stop set (and a build claimed in between makes this claim 409).
        with sync_routing_slot(self._projects, project):
            return self._append(project, stops, pa, clean_mapping(import_mapping or {}))

    def delete(self, project_id: str, stop_uid: str) -> None:
        """Delete one store for good, with its screens, its ExtID (free to use again) and its visits. Refused while
        the store is in a route plan (take it out of the plan first) or while routing is being built."""
        project = self._project(project_id)
        stop = self.get(project_id, stop_uid)
        if project.routing_status == RoutingStatus.BUILDING:
            raise ConflictError("Routing is in progress; delete the store once it finishes")
        if stop.route_plan_id:
            raise ConflictError("This store is in a route plan. Take it out of the plan first, then delete it.")
        if self._stores.delete(project_id, stop_uid):
            assert self._projects is not None
            self._projects.update(project_id, {"stop_count": max(project.stop_count - 1, 0)})

    def add_one(self, project_id: str, values: dict[str, Any]) -> Stop:
        """Add one store typed in by hand, checked like a sheet row: ExtID, store name and address are required and
        well-formed; the ExtID and the address are new to the project (a duplicate names the store that has them);
        Google verifies the address (a partial or failed match is refused with suggestions). A suggestion sent back
        as the address alone ("12 Main St, Macon, GA 31201, USA") fills the city, state and ZIP from it."""
        project = self._project(project_id)
        clean = {name: str(values.get(name) or "").strip() for name in ("store_name", *ADDRESS_PARTS)}
        clean["external_id"] = normalize_external_id(values.get("external_id") or "")
        if not any(clean[name] for name in ("city", "state", "zip")):
            clean.update(parse_us_formatted_address(clean["addr"]))  # a picked suggestion: split it
        problems = validate_store_values(clean, partial=True)
        for name, label in (("external_id", "ExtID"), ("store_name", "Store name"), ("addr", "Address")):
            if not clean[name]:
                problems.setdefault(name, f"{label} is required")
        if problems:
            raise ValidationFailed("; ".join(problems.values()), errors=list(problems.values()), fields=problems)

        stop = StopInput(**clean)
        existing = self._stores.list_all(project_id)
        _, skipped = split_duplicates(existing, [stop], single_pa(project.pa))
        if skipped:
            by_id = skipped[0]["reason"] == "external_id"
            same = next(
                (other for other in existing
                 if (normalize_external_id(other.external_id) == clean["external_id"] if by_id else
                     dedupe_key_address(other.model_dump()) == dedupe_key_address(clean))), None)
            where = " · ".join(part for part in (same.store_name, same.external_id) if part) if same else "a store"
            name = "external_id" if by_id else "addr"
            what = f"ExtID {clean['external_id']}" if by_id else "This address"
            message = f"{what} is already in the project: {where}"
            raise ValidationFailed(message, errors=[message], fields={name: message})

        assert self._geocoder is not None
        lookup = ", ".join(clean[key] for key in ADDRESS_PARTS if clean[key])
        geo = resolve_address(self._geocoder, lookup, clean["store_name"])
        if not geo.get("ok") or geo.get("partial"):
            raise ValidationFailed(
                "Address could not be verified by Google. Pick a suggestion or correct the address.",
                google_status=geo.get("status"), suggestions=geo.get("suggestions") or [], address=lookup,
            )
        stop = stop.model_copy(update={"lat": geo.get("lat"), "lng": geo.get("lng"),
                                       "geocoded": geo.get("formatted") or lookup})
        self.append(project_id, [stop])
        added = next((other for other in self._stores.list_all(project_id)
                      if normalize_external_id(other.external_id) == clean["external_id"]), None)
        if added is None:  # skipped by a store added in between
            raise ConflictError("The store was added by someone else just now; reload the list")
        return added

    @staticmethod
    def _new_stop(project: Project, stop: StopInput, display_id: str, installer: str, day: int, seq: int) -> Stop:
        """An appended stop; `installer` "" leaves it unrouted (the project has no installers yet)."""
        return Stop(
            uid=uuid.uuid4().hex,
            display_id=display_id,
            store_name=stop.store_name.strip(),
            addr=stop.addr.strip(),
            city=stop.city.strip(),
            state=stop.state.strip(),
            zip=stop.zip.strip(),
            lat=stop.lat,
            lng=stop.lng,
            geocoded=stop.geocoded.strip(),
            installer=installer,
            day=day,
            seq=seq,  # end of that day's route
            fields=coerce_fields(project.field_schema, stop.fields),
            **stop_details(stop),
            screens=stop.build_screens(),
            installer_name=stop.installer_name.strip(),
            review_notes=stop.review_notes.strip(),
            needs_attention=attention_of(stop),
        )

    def _append(self, project: Project, stops: list[StopInput], pa: str, mapping: dict[str, str]) -> dict[str, Any]:
        """The append itself, run while holding the routing slot so a build cannot compute over the old stop set."""
        project_id = project.id
        installers = [name for name in project.installers if name]  # none yet: the new stores stay unrouted
        schema = with_sheet_fields(project.field_schema, stops)  # new "Other imported data" columns join the schema
        added_fields = len(schema) > len(project.field_schema)
        if added_fields:
            project = project.model_copy(update={"field_schema": schema})
        bad = validate_stop_inputs(project.field_schema, stops)
        if bad:
            raise ValidationFailed(f"{len(bad)} stop(s) need fixing", errors=[], stops=bad)

        existing = self._stores.list_all(project_id)
        # by ExtID, then PA + address; within the sheet and against the project
        keep, skipped = split_duplicates(existing, stops, single_pa(project.pa))
        candidates = [stops[index] for index in keep]

        max_number = max(
            (int(match.group(1)) for stop in existing if (match := re.fullmatch(r"S(\d+)", stop.display_id))),
            default=0,
        )
        per_day = project.stops_per_day
        # installer -> day -> stops, for the greedy placement
        days: dict[str, dict[int, list[Stop]]] = {name: defaultdict(list) for name in installers}
        for stop in existing:
            if stop.installer in days:
                days[stop.installer][stop.day].append(stop)

        appended: list[Stop] = []
        for offset, stop in enumerate(candidates, start=1):
            if not installers:
                appended.append(self._new_stop(project, stop, f"S{max_number + offset}", "", 1, offset - 1))
                continue
            installer = min(installers, key=lambda name: sum(len(day) for day in days[name].values()))
            stop_state = state_key({"state": stop.state})
            open_days = [
                number
                for number, rows in days[installer].items()
                if rows and len(rows) < per_day and all(state_key({"state": row.state}) == stop_state for row in rows)
            ]
            if open_days:
                day = min(open_days, key=lambda number: (len(days[installer][number]), number))
            else:
                day = max((number for number, rows in days[installer].items() if rows), default=0) + 1
            new = self._new_stop(project, stop, f"S{max_number + offset}", installer, day, len(days[installer][day]))
            days[installer][day].append(new)
            appended.append(new)

        if appended:
            self._stores.put_many(project_id, appended)
            pa_values = {clean_cell(part) for part in project.pa.split(",") if clean_cell(part)}
            pa_values |= {clean_cell(part) for part in pa.split(",") if clean_cell(part)}
            pa_values |= {value for stop in appended if (value := clean_cell(stop.pa))}
            assert self._projects is not None
            changes: dict[str, Any] = {
                "stop_count": len(existing) + len(appended), "pa": ", ".join(sorted(pa_values)) or project.pa
            }
            if mapping:  # the next sheet of this shape maps the same way
                changes["import_mappings"] = {**project.import_mappings, **mapping}
            if added_fields:
                changes["field_schema"] = [field.model_dump(mode="json") for field in project.field_schema]
            self._projects.update(project_id, changes)
        return {"appended": len(appended), "skipped": skipped, "total": len(existing) + len(appended)}
