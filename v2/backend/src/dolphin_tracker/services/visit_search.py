"""Log Visit: find a store in any project by a screen's DD code or by the store's address, name or ExtID.

Stores are partitioned per project, so a search reads every project's stores (projected, a few attributes, as the
Route Planner's store picker does) and matches in memory. People type a search a few characters at a time, so on
DynamoDB the projected lists are kept for STORE_CACHE_SECONDS per warm Lambda, like the picker's all-venues list.
"""
from __future__ import annotations

import time
from typing import Any

from dolphin_tracker.domain.models import Project
from dolphin_tracker.domain.search import search_words
from dolphin_tracker.domain.venues import VENUES_PROJECT_ID
from dolphin_tracker.domain.visit_search import (
    MIN_QUERY,
    VisitSearchResult,
    code_needle,
    match_store,
    to_row,
)
from dolphin_tracker.repositories.projects import ProjectRepository
from dolphin_tracker.repositories.stores import StoreRepository

SEARCH_ATTRIBUTES = (
    "uid", "display_id", "external_id", "store_name", "addr", "city", "state", "zip", "status", "screens",
)
# A store's status may show up to this many seconds old in the results (the visit dialog reads the store afresh).
STORE_CACHE_SECONDS = 30
_STORE_CACHE: dict[tuple[str, str], tuple[float, list[dict[str, Any]]]] = {}


class VisitSearchService:
    def __init__(self, projects: ProjectRepository, stores: StoreRepository) -> None:
        self._projects = projects
        self._stores = stores

    def _all_projects(self) -> list[Project]:
        """Every real project: the Dolphin data's all-venues list is not one (the project list never holds it; it
        is dropped here too, so it can never slip in)."""
        projects: list[Project] = []
        cursor = None
        while True:
            page = self._projects.list(limit=100, cursor=cursor)
            projects.extend(project for project in page.items if project.id != VENUES_PROJECT_ID)
            if not page.next_cursor:
                return projects
            cursor = page.next_cursor

    def _items(self, project_id: str) -> list[dict[str, Any]]:
        table = getattr(getattr(self._stores, "_table", None), "name", None)
        if table is None:  # not the DynamoDB repository (tests): nothing to save
            return self._stores.list_projected(project_id, SEARCH_ATTRIBUTES)
        cached = _STORE_CACHE.get((table, project_id))
        if cached is None or time.monotonic() - cached[0] > STORE_CACHE_SECONDS:
            cached = (time.monotonic(), self._stores.list_projected(project_id, SEARCH_ATTRIBUTES))
            _STORE_CACHE[(table, project_id)] = cached
        return cached[1]

    def search(self, q: str, *, limit: int = 25) -> VisitSearchResult:
        """The best `limit` stores for the query, and how many matched in all. A query of fewer than MIN_QUERY
        characters (or with no word in it) finds nothing."""
        query = " ".join(q.split())
        if len(query) < MIN_QUERY or not search_words(query):
            return VisitSearchResult(items=[], total=0)
        needle = code_needle(query)
        found = []
        for project in self._all_projects():
            for item in self._items(project.id):
                matched = match_store(query, needle, item)
                if matched is not None:
                    kinds, screen_ids, rank = matched
                    found.append((rank, project, item, kinds, screen_ids))
        found.sort(key=lambda hit: (
            hit[0], str(hit[2].get("store_name") or "").lower(), hit[1].name.lower(), hit[2]["uid"],
        ))
        return VisitSearchResult(
            items=[to_row(project.id, project.name, item, kinds, screen_ids)
                   for _, project, item, kinds, screen_ids in found[:limit]],
            total=len(found),
        )
