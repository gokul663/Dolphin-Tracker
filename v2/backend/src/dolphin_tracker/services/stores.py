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
from dataclasses import dataclass, field
from typing import Any

from dolphin_tracker.domain.errors import NotFoundError, ValidationFailed
from dolphin_tracker.domain.models import PROGRESS_FIELDS, Page, Project, Stop, StopStatus
from dolphin_tracker.domain.schema import coerce_fields, validate_fields
from dolphin_tracker.repositories.dynamo import decode_cursor, encode_cursor
from dolphin_tracker.repositories.projects import ProjectRepository
from dolphin_tracker.repositories.stores import StoreRepository
from dolphin_tracker.services.geocoding import Geocoder

SORT_KEYS = ("store_name", "addr", "status", "installer", "day", "updated_at", "display_id")
ADDRESS_PARTS = ("addr", "city", "state", "zip")
DETAIL_TEXT_FIELDS = ("store_name", *ADDRESS_PARTS)
CSV_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


@dataclass
class StoreQuery:
    status: list[StopStatus] = field(default_factory=list)
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
        offset = int((decode_cursor(cursor) or {}).get("offset", 0))
        if offset < 0:
            raise ValueError("Invalid cursor")
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
        self.get(project_id, stop_uid)
        update = {key: value for key, value in changes.items() if value is not None}
        extra = set(update) - PROGRESS_FIELDS
        if extra:
            raise ValueError(f"Not progress fields: {sorted(extra)}")
        if not update:
            raise ValidationFailed("Nothing to update")
        if isinstance(update.get("status"), StopStatus):
            update["status"] = update["status"].value
        return self._stores.update_fields(project_id, stop_uid, update)
