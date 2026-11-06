"""The cross-project store picker for the Route Planner (ROUTE-PLANNER §4, §7).

Stores are partitioned per project, so a search reads every project's stores (projected, a few attributes) and
filters in memory, then pages with an offset cursor. That is fine for thousands of stores; a GSI on state is the
next step if it ever is not."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from dolphin_tracker.domain.cursors import encode_cursor, offset_from_cursor
from dolphin_tracker.domain.models import PENDING_STATUSES, Page, Project, ScreenStatus
from dolphin_tracker.domain.route_plans import PoolStore
from dolphin_tracker.repositories.projects import ProjectRepository
from dolphin_tracker.repositories.stores import StoreRepository

POOL_ATTRIBUTES = (
    "uid", "external_id", "store_name", "addr", "city", "state", "zip", "lat", "lng", "status", "screens",
    "route_plan_id", "pa", "dma",
)
MAX_PINS = 5000


@dataclass
class PoolQuery:
    state: list[str] = field(default_factory=list)
    city: list[str] = field(default_factory=list)
    project_id: list[str] = field(default_factory=list)
    status: list[ScreenStatus] = field(default_factory=list)
    pending_only: bool = False
    available_only: bool = False  # hide stores already in a plan
    q: str = ""


def _norm(value: Any) -> str:
    return " ".join(str(value or "").split()).lower()


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

    def _rows(self, project_ids: list[str] | None = None) -> list[PoolStore]:
        rows: list[PoolStore] = []
        for project in self._all_projects():
            if project_ids and project.id not in project_ids:
                continue
            for item in self._stores.list_projected(project.id, POOL_ATTRIBUTES):
                screens = item.get("screens") or []
                rows.append(PoolStore(
                    project_id=project.id,
                    project_name=project.name,
                    uid=item["uid"],
                    external_id=item.get("external_id") or "",
                    store_name=item.get("store_name") or "",
                    addr=item.get("addr") or "",
                    city=item.get("city") or "",
                    state=item.get("state") or "",
                    zip=item.get("zip") or "",
                    lat=item.get("lat"),
                    lng=item.get("lng"),
                    status=item.get("status") or ScreenStatus.UPCOMING.value,
                    screen_count=max(1, len(screens)),
                    pa=item.get("pa") or project.pa,
                    dma=item.get("dma") or "",
                    route_plan_id=item.get("route_plan_id") or "",
                ))
        return rows

    @staticmethod
    def _match(row: PoolStore, query: PoolQuery, *, skip: str = "") -> bool:
        if skip != "project" and query.project_id and row.project_id not in query.project_id:
            return False
        if skip != "state" and query.state and _norm(row.state) not in {_norm(s) for s in query.state}:
            return False
        if skip != "city" and query.city and _norm(row.city) not in {_norm(c) for c in query.city}:
            return False
        if query.status and row.status not in {status.value for status in query.status}:
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
        """Distinct states, cities and projects with counts. Each facet ignores its own filter, so picking one value
        never hides the others."""
        rows = self._rows()
        states: dict[str, int] = {}
        cities: dict[str, int] = {}
        projects: dict[tuple[str, str], int] = {}
        for row in rows:
            if self._match(row, query, skip="state") and row.state:
                states[row.state.upper()] = states.get(row.state.upper(), 0) + 1
            if self._match(row, query, skip="city") and row.city:
                cities[row.city] = cities.get(row.city, 0) + 1
            if self._match(row, query, skip="project"):
                projects[(row.project_id, row.project_name)] = projects.get((row.project_id, row.project_name), 0) + 1
        return {
            "states": [{"value": k, "count": v} for k, v in sorted(states.items())],
            "cities": [{"value": k, "count": v} for k, v in sorted(cities.items(), key=lambda kv: kv[0].lower())],
            "projects": [{"value": pid, "label": name, "count": count}
                         for (pid, name), count in sorted(projects.items(), key=lambda kv: kv[0][1].lower())],
        }
