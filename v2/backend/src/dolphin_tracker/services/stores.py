"""Store use cases: listing (filter, search, sort, paginate), map pins, CSV export, detail and progress edits.

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
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from dolphin_tracker.domain.addresses import duplicate_key
from dolphin_tracker.domain.cursors import encode_cursor, offset_from_cursor
from dolphin_tracker.domain.errors import ConflictError, NotFoundError, ValidationFailed
from dolphin_tracker.domain.models import (
    PROGRESS_FIELDS,
    Page,
    Project,
    RoutingStatus,
    ScreenStatus,
    Stop,
    StopInput,
    derive_store_status,
)
from dolphin_tracker.domain.parsing import clean_cell
from dolphin_tracker.domain.route_optimizer import state_key
from dolphin_tracker.domain.schema import coerce_fields, validate_fields, validate_stop_inputs
from dolphin_tracker.domain.validation import stop_details
from dolphin_tracker.repositories.projects import ProjectRepository
from dolphin_tracker.repositories.stores import StoreRepository
from dolphin_tracker.services.geocoding import Geocoder
from dolphin_tracker.services.routing import sync_routing_slot

SORT_KEYS = ("store_name", "addr", "status", "installer", "day", "updated_at", "display_id")
ADDRESS_PARTS = ("addr", "city", "state", "zip")
DETAIL_TEXT_FIELDS = ("store_name", *ADDRESS_PARTS)
CSV_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


@dataclass
class StoreQuery:
    status: list[ScreenStatus] = field(default_factory=list)
    installer: list[str] = field(default_factory=list)  # "" matches unassigned stops
    q: str = ""
    sort: str = "store_name"
    dir: str = "asc"


def _natural(value: str) -> tuple:
    """'S10' after 'S9'."""
    return tuple(int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", value))


def _sort_value(stop: Stop, sort: str) -> Any:
    if sort.startswith("fields."):
        value = stop.fields.get(sort.removeprefix("fields."))
    else:
        value = getattr(stop, sort)
    if value is None or value == "":
        return None
    if sort == "display_id":
        return (1, _natural(value))
    if isinstance(value, bool):
        return (0, int(value))
    if isinstance(value, (int, float)):
        return (0, value)
    return (1, str(value).lower())


def _matches(stop: Stop, needle: str) -> bool:
    haystack = [stop.display_id, stop.store_name, stop.addr, stop.city, stop.zip, stop.comment]
    haystack.extend(str(value) for value in stop.fields.values() if value not in (None, ""))
    return any(needle in text.lower() for text in haystack)


def _csv_cell(value: Any) -> Any:
    """Neutralise spreadsheet formulas (CSV injection) in exported text cells."""
    if isinstance(value, str) and value.startswith(CSV_FORMULA_PREFIXES):
        return "'" + value
    return value


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

    def _query(self, project: Project, query: StoreQuery) -> list[Stop]:
        sort = query.sort or "store_name"
        if sort not in SORT_KEYS and not sort.startswith("fields."):
            raise ValueError(f"Unknown sort {sort!r}")
        if sort.startswith("fields.") and sort.removeprefix("fields.") not in {f.key for f in project.field_schema}:
            raise ValueError(f"Unknown sort field {sort!r}")
        if query.dir not in ("asc", "desc"):
            raise ValueError("dir must be asc or desc")

        stops = self._stores.list_all(project.id)
        if query.status:
            wanted = set(query.status)
            stops = [stop for stop in stops if stop.status in wanted]
        if query.installer:
            wanted_installers = set(query.installer)
            stops = [stop for stop in stops if stop.installer in wanted_installers]
        needle = query.q.strip().lower()
        if needle:
            stops = [stop for stop in stops if _matches(stop, needle)]

        # Stable two-step sort: a deterministic tie-break first, then the requested key; blanks always last.
        stops.sort(key=lambda stop: (_natural(stop.display_id), stop.uid))
        present = [stop for stop in stops if _sort_value(stop, sort) is not None]
        blank = [stop for stop in stops if _sort_value(stop, sort) is None]
        present.sort(key=lambda stop: _sort_value(stop, sort), reverse=query.dir == "desc")
        return present + blank

    def list(
        self, project_id: str, query: StoreQuery | None = None, *, limit: int = 50, cursor: str | None = None
    ) -> Page[Stop]:
        project = self._project(project_id)
        offset = offset_from_cursor(cursor)
        stops = self._query(project, query or StoreQuery())
        window = stops[offset : offset + limit]
        next_cursor = encode_cursor({"offset": offset + limit}) if offset + limit < len(stops) else None
        return Page(items=window, next_cursor=next_cursor)

    def get(self, project_id: str, stop_uid: str) -> Stop:
        self._project(project_id)
        stop = self._stores.get(project_id, stop_uid)
        if stop is None:
            raise NotFoundError(f"Stop {stop_uid} not found")
        return stop

    def pins(self, project_id: str, query: StoreQuery | None = None) -> list[dict[str, Any]]:
        """Whole-project map payload, located stops only (deliberately unpaginated, rule 4)."""
        project = self._project(project_id)
        return [
            {
                "uid": stop.uid,
                "lat": stop.lat,
                "lng": stop.lng,
                "status": stop.status,
                "store_name": stop.store_name,
                "installer": stop.installer,
                "day": stop.day,
            }
            for stop in self._query(project, query or StoreQuery())
            if stop.lat is not None and stop.lng is not None
        ]

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
        """Core columns, then schema columns by label, then progress. Same filters and order as the list."""
        project = self._project(project_id)
        schema = project.field_schema
        header = [
            "ID", "Store Name", "Address", "City", "State", "ZIP", "Lat", "Lng", "Installer", "Day", "Seq",
            *[f.label for f in schema],
            "Status", "Comment", "Additional Task", "Installer Name", "Updated By", "Updated At",
        ]
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(header)
        for stop in self._query(project, query or StoreQuery()):
            row = [
                stop.display_id, stop.store_name, stop.addr, stop.city, stop.state, stop.zip,
                "" if stop.lat is None else stop.lat, "" if stop.lng is None else stop.lng,
                stop.installer, stop.day, stop.seq,
                *[stop.fields.get(f.key, "") for f in schema],
                stop.status.value, stop.comment, "yes" if stop.additional_task else "no",
                stop.installer_name, stop.updated_by, stop.updated_at,
            ]
            writer.writerow([_csv_cell(value) for value in row])
        return buffer.getvalue()

    # ---- writes -------------------------------------------------------------------------------------------

    def update_details(self, project_id: str, stop_uid: str, changes: dict[str, Any]) -> Stop:
        """Edit store name, address parts and schema fields. A changed address is geocoded first; partial or
        failed matches are refused with suggestions. Routing and progress attributes are never part of this write."""
        project = self._project(project_id)
        current = self.get(project_id, stop_uid)
        update: dict[str, Any] = {}
        errors: list[str] = []

        for key in DETAIL_TEXT_FIELDS:
            if key in changes and changes[key] is not None:
                update[key] = str(changes[key]).strip()
        if update.get("store_name", current.store_name) == "":
            errors.append("Store name is required")
        if update.get("addr", current.addr) == "":
            errors.append("Address is required")
        fields = changes.get("fields") or {}
        errors.extend(validate_fields(project.field_schema, fields, partial=True))
        if errors:
            raise ValidationFailed("; ".join(errors), errors=errors)

        address_changed = any(key in update and update[key] != getattr(current, key) for key in ADDRESS_PARTS)
        if address_changed:
            assert self._geocoder is not None
            parts = [update.get(key, getattr(current, key)) for key in ADDRESS_PARTS]
            lookup = ", ".join(part for part in parts if part)
            geo = self._geocoder.geocode(lookup)
            if not geo.get("ok") or geo.get("partial"):
                raise ValidationFailed(
                    "Address could not be verified by Google. Please enter a more specific address.",
                    google_status=geo.get("status"),
                    suggestions=geo.get("suggestions") or self._geocoder.autocomplete(lookup),
                )
            update.update(lat=geo.get("lat"), lng=geo.get("lng"), geocoded=geo.get("formatted") or lookup)
            update["route_stale"] = True  # the routes were built for the old location
        else:
            for key in ADDRESS_PARTS:  # unchanged parts need no write
                if key in update and update[key] == getattr(current, key):
                    update.pop(key)

        for key, value in coerce_fields(project.field_schema, fields).items():
            update[f"fields.{key}"] = value  # one entry each, so concurrent edits to other fields survive
        if "store_name" in update and update["store_name"] == current.store_name:
            update.pop("store_name")
        if not update:
            return current
        return self._stores.update_fields(project_id, stop_uid, update)

    def update_progress(self, project_id: str, stop_uid: str, changes: dict[str, Any]) -> Stop:
        """Status / comment / additional task / installer name / updated_by only."""
        current = self.get(project_id, stop_uid)
        update = {key: value for key, value in changes.items() if value is not None}
        extra = set(update) - PROGRESS_FIELDS
        if extra:
            raise ValueError(f"Not progress fields: {sorted(extra)}")
        if not update:
            raise ValidationFailed("Nothing to update")
        if "status" in update:  # status lives on the screens: set every screen, then the derived summary
            status = ScreenStatus(update["status"])
            screens = [screen.model_copy(update={"status": status}) for screen in current.screens]
            update["screens"] = [screen.model_dump(mode="json") for screen in screens]
            update["status"] = derive_store_status(screens).value
        return self._stores.update_fields(project_id, stop_uid, update)

    # ---- append -------------------------------------------------------------------------------------------

    @staticmethod
    def _identity(stop: Stop | StopInput) -> str:
        return duplicate_key(
            {
                "venue_code": stop.fields.get("venue_code", ""),
                "addr": stop.addr,
                "city": stop.city,
                "state": stop.state,
                "zip": stop.zip,
            }
        )

    def append(self, project_id: str, stops: list[StopInput], pa: str = "") -> dict[str, Any]:
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
            return self._append(project, stops, pa)

    def _append(self, project: Project, stops: list[StopInput], pa: str) -> dict[str, Any]:
        """The append itself, run while holding the routing slot so a build cannot compute over the old stop set."""
        project_id = project.id
        installers = [name for name in project.installers if name]
        if not installers:
            raise ValidationFailed("Project needs at least one installer before appending stops")
        bad = validate_stop_inputs(project.field_schema, stops)
        if bad:
            raise ValidationFailed(f"{len(bad)} stop(s) need fixing", errors=[], stops=bad)

        existing = self._stores.list_all(project_id)
        known = {key for key in (self._identity(stop) for stop in existing) if key}
        skipped: list[dict[str, str]] = []
        candidates: list[StopInput] = []
        for stop in stops:
            key = self._identity(stop)
            if key and key in known:
                skipped.append(
                    {"addr": stop.addr, "venue_code": str(stop.fields.get("venue_code", "")), "reason": "duplicate"}
                )
                continue
            if key:
                known.add(key)
            candidates.append(stop)

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
            new = Stop(
                uid=uuid.uuid4().hex,
                display_id=f"S{max_number + offset}",
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
                seq=len(days[installer][day]),  # end of that day's route
                fields=coerce_fields(project.field_schema, stop.fields),
                **stop_details(stop),
                screens=stop.build_screens(),
            )
            days[installer][day].append(new)
            appended.append(new)

        if appended:
            self._stores.put_many(project_id, appended)
            pa_values = {clean_cell(part) for part in project.pa.split(",") if clean_cell(part)}
            pa_values |= {clean_cell(part) for part in pa.split(",") if clean_cell(part)}
            pa_values |= {value for stop in appended if (value := clean_cell(stop.fields.get("pa")))}
            assert self._projects is not None
            self._projects.update(
                project_id,
                {"stop_count": len(existing) + len(appended), "pa": ", ".join(sorted(pa_values)) or project.pa},
            )
        return {"appended": len(appended), "skipped": skipped, "total": len(existing) + len(appended)}
