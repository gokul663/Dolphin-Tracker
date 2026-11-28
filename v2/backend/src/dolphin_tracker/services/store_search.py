"""The cross-project store picker for the Route Planner (ROUTE-PLANNER §4, §7).

Stores are partitioned per project, so a search reads every project's stores (projected, a few attributes) and
filters in memory, then pages with an offset cursor. That is fine for thousands of stores; a GSI on state is the
next step if it ever is not."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from dolphin_tracker.domain.addresses import state_code
from dolphin_tracker.domain.cursors import encode_cursor, offset_from_cursor
from dolphin_tracker.domain.device import split_codes, venue_code_key
from dolphin_tracker.domain.models import PENDING_STATUSES, Page, Project, ProjectType, ScreenStatus
from dolphin_tracker.domain.route_plans import PoolStore
from dolphin_tracker.domain.statuses import STORE_BUCKET_ORDER, StatusBucket, store_bucket_of
from dolphin_tracker.domain.venues import VENUES_PROJECT_ID, VENUES_PROJECT_NAME
from dolphin_tracker.repositories.projects import ProjectRepository
from dolphin_tracker.repositories.stores import StoreRepository

POOL_ATTRIBUTES = (
    "uid", "external_id", "store_name", "addr", "city", "state", "zip", "lat", "lng", "status", "screens",
    "route_plan_id", "pa", "dma", "display_id",
)
MAX_PINS = 20000  # every routable venue of the CMS data fits (about 7,500 today)


@dataclass
class PoolQuery:
    state: list[str] = field(default_factory=list)
    city: list[str] = field(default_factory=list)
    project_id: list[str] = field(default_factory=list)
    dma: list[str] = field(default_factory=list)
    pa: list[str] = field(default_factory=list)
    bucket: list[StatusBucket] = field(default_factory=list)  # the store's status group, as the map colours it
    status: list[ScreenStatus] = field(default_factory=list)
    pending_only: bool = False
    available_only: bool = False  # hide stores already in a plan
    q: str = ""


def _norm(value: Any) -> str:
    return " ".join(str(value or "").split()).lower()


VENUE_CACHE_SECONDS = 30
_VENUE_CACHE: dict[str, tuple[float, list[dict[str, Any]]]] = {}
NOT_ROUTED = frozenset({StatusBucket.ARCHIVED, StatusBucket.CANCELLED})


def _bucket(status: str) -> StatusBucket | None:
    """The store's status group; None for a status the app does not know (an old record), which is in no group."""
    try:
        return store_bucket_of(status)
    except ValueError:
        return None


class StoreSearchService:
    def __init__(self, projects: ProjectRepository, stores: StoreRepository) -> None:
        self._projects = projects
        self._stores = stores

    def _all_projects(self) -> list[Project]:
        projects: list[Project] = []
        cursor = None
        while True:
            page = self._projects.list(limit=100, cursor=cursor)
            projects.extend(page.items)
            if not page.next_cursor:
                return projects
            cursor = page.next_cursor

    def _venue_items(self) -> list[dict[str, Any]]:
        """The all-venues list, read at most once every VENUE_CACHE_SECONDS per table: it is thousands of rows, read
        on every filter change, and changes once a day. (A venue just put in a plan may show as free for that long;
        the plan itself still refuses a store another plan holds.)"""
        table = getattr(getattr(self._stores, "_table", None), "name", None)
        if table is None:  # not the DynamoDB repository (tests): nothing to save
            return self._stores.list_projected(VENUES_PROJECT_ID, POOL_ATTRIBUTES)
        cached = _VENUE_CACHE.get(table)
        if cached is None or time.monotonic() - cached[0] > VENUE_CACHE_SECONDS:
            cached = (time.monotonic(), self._stores.list_projected(VENUES_PROJECT_ID, POOL_ATTRIBUTES))
            _VENUE_CACHE[table] = cached
        return cached[1]

    def _rows(self, project_ids: list[str] | None = None) -> list[PoolStore]:
        """Every project's stores, then every other venue of the CMS data (the all-venues list): a venue whose
        DD code is on a project's store is that store, so it is not listed a second time."""
        rows: list[PoolStore] = []
        in_projects: set[str] = set()  # DD codes on project stores, whatever their status
        everything = Project(id=VENUES_PROJECT_ID, name=VENUES_PROJECT_NAME, project_type=ProjectType.OFFLINE)
        for project in [*self._all_projects(), everything]:
            outside = project.id == VENUES_PROJECT_ID
            wanted = not project_ids or project.id in project_ids
            if not wanted and (outside or VENUES_PROJECT_ID not in project_ids):
                continue  # (a project that is not asked for is still read when the other venues are: for its codes)
            for item in (self._venue_items() if outside else self._stores.list_projected(project.id, POOL_ATTRIBUTES)):
                screens = item.get("screens") or []
                codes = {venue_code_key(code) for screen in screens for code in split_codes(screen.get("venue_id"))}
                if outside and codes & in_projects:
                    continue
                if not outside:
                    in_projects |= codes
                if not wanted:
                    continue
                if _bucket(item.get("status") or ScreenStatus.UPCOMING.value) in NOT_ROUTED:
                    continue  # archived and cancelled stores are never sent an installer
                rows.append(PoolStore(
                    project_id=project.id,
                    project_name=project.name,
                    uid=item["uid"],
                    external_id=item.get("external_id") or (item.get("display_id") or "" if outside else ""),
                    store_name=item.get("store_name") or "",
                    addr=item.get("addr") or "",
                    city=item.get("city") or "",
                    # One spelling per state ("Illinois", "ILLINOIS", "il" → "IL"), as the verified address has it.
                    state=state_code(item.get("state") or ""),
                    zip=item.get("zip") or "",
                    lat=item.get("lat"),
                    lng=item.get("lng"),
                    status=item.get("status") or ScreenStatus.UPCOMING.value,
                    screen_count=max(1, len(screens)),
                    pa=item.get("pa") or ("" if outside else project.pa),
                    dma=item.get("dma") or "",
                    route_plan_id=item.get("route_plan_id") or "",
                ))
        return rows

    @staticmethod
    def _match(row: PoolStore, query: PoolQuery, *, skip: str = "") -> bool:
        if skip != "project" and query.project_id and row.project_id not in query.project_id:
            return False
        if skip != "state" and query.state and _norm(row.state) not in {_norm(state_code(s)) for s in query.state}:
            return False
        if skip != "pa" and query.pa and _norm(row.pa) not in {_norm(p) for p in query.pa}:
            return False
        if skip != "dma" and query.dma and _norm(row.dma) not in {_norm(d) for d in query.dma}:
            return False
        if skip != "city" and query.city and _norm(row.city) not in {_norm(c) for c in query.city}:
            return False
        if skip != "bucket" and query.bucket and _bucket(row.status) not in query.bucket:
            return False
        if skip != "status" and query.status and row.status not in {status.value for status in query.status}:
            return False
        if query.pending_only and row.status not in {status.value for status in PENDING_STATUSES}:
            return False
        if query.available_only and row.route_plan_id:
            return False
        if query.q:
            needle = _norm(query.q)
            haystack = " ".join(_norm(v) for v in (row.store_name, row.external_id, row.addr, row.city, row.zip))
            if needle not in haystack:
                return False
        return True

    def _filtered(self, query: PoolQuery) -> list[PoolStore]:
        rows = [row for row in self._rows(query.project_id) if self._match(row, query)]
        return sorted(rows, key=lambda r: (_norm(r.state), _norm(r.city), _norm(r.store_name), r.project_id, r.uid))

    def search(self, query: PoolQuery, *, limit: int = 50, cursor: str | None = None) -> Page[PoolStore]:
        rows = self._filtered(query)
        start = offset_from_cursor(cursor)
        window = rows[start : start + limit]
        next_cursor = encode_cursor({"offset": start + limit}) if start + limit < len(rows) else None
        return Page(items=window, next_cursor=next_cursor)

    def pins(self, query: PoolQuery) -> list[PoolStore]:
        """Every match (the map and "select all"), capped."""
        return self._filtered(query)[:MAX_PINS]

    def facets(self, query: PoolQuery) -> dict[str, list[dict[str, Any]]]:
        """Distinct states, cities, DMAs, statuses and projects with counts. Each facet ignores its own filter, so
        picking one value never hides the others."""
        rows = self._rows()
        states: dict[str, int] = {}
        cities: dict[str, int] = {}
        projects: dict[tuple[str, str], int] = {}
        dmas: dict[str, tuple[str, int]] = {}  # by normalised name → (first spelling, count)
        statuses: dict[str, int] = {}
        buckets: dict[StatusBucket, int] = {}
        pas: dict[str, tuple[str, int]] = {}
        for row in rows:
            if self._match(row, query, skip="pa") and row.pa.strip():
                label, count = pas.get(_norm(row.pa), (" ".join(row.pa.split()), 0))
                pas[_norm(row.pa)] = (label, count + 1)
            group = _bucket(row.status)
            if group is not None and self._match(row, query, skip="bucket"):
                buckets[group] = buckets.get(group, 0) + 1
            if self._match(row, query, skip="dma") and row.dma.strip():
                label, count = dmas.get(_norm(row.dma), (" ".join(row.dma.split()), 0))
                dmas[_norm(row.dma)] = (label, count + 1)
            if self._match(row, query, skip="status"):
                statuses[row.status] = statuses.get(row.status, 0) + 1
            if self._match(row, query, skip="state") and row.state:
                states[row.state.upper()] = states.get(row.state.upper(), 0) + 1
            if self._match(row, query, skip="city") and row.city:
                cities[row.city] = cities.get(row.city, 0) + 1
            if self._match(row, query, skip="project"):
                projects[(row.project_id, row.project_name)] = projects.get((row.project_id, row.project_name), 0) + 1
        return {
            "states": [{"value": k, "count": v} for k, v in sorted(states.items())],
            "cities": [{"value": k, "count": v} for k, v in sorted(cities.items(), key=lambda kv: kv[0].lower())],
            "dmas": [{"value": label, "count": count}
                     for label, count in sorted(dmas.values(), key=lambda item: item[0].lower())],
            "statuses": [{"value": status.value, "count": statuses[status.value]}
                         for status in ScreenStatus if status.value in statuses],
            "buckets": [{"value": bucket.value, "count": buckets.get(bucket, 0)}
                        for bucket in STORE_BUCKET_ORDER if bucket not in NOT_ROUTED],
            "pas": [{"value": label, "count": count}
                    for label, count in sorted(pas.values(), key=lambda item: item[0].lower())],
            "projects": [{"value": pid, "label": name, "count": count}
                         for (pid, name), count in sorted(projects.items(), key=lambda kv: kv[0][1].lower())],
        }
