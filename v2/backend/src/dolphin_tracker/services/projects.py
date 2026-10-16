"""Project use cases. Read paths are implemented; create/update land with the Phase 2 endpoint port."""
from __future__ import annotations

from typing import Any

from dolphin_tracker.domain.errors import NotFoundError
from dolphin_tracker.domain.models import Page, Project
from dolphin_tracker.repositories.projects import ProjectRepository
from dolphin_tracker.repositories.stores import StoreRepository


class ProjectService:
    def __init__(self, projects: ProjectRepository, stores: StoreRepository | None = None) -> None:
        self._projects = projects
        self._stores = stores

    def list(self, *, limit: int = 50, cursor: str | None = None) -> Page[Project]:
        return self._projects.list(limit=limit, cursor=cursor)

    def get(self, project_id: str) -> Project:
        project = self._projects.get(project_id)
        if project is None:
            raise NotFoundError(f"Project {project_id} not found")
        return project

    def create(self, payload: dict[str, Any]) -> Project:
        raise NotImplementedError(
            "Phase 2: validate, write META with routing_status=building, write stops, enqueue routing_build job"
        )

    def update(self, project_id: str, changes: dict[str, Any], *, expected_version: int | None = None) -> Project:
        return self._projects.update(project_id, changes, expected_version=expected_version)

    def delete(self, project_id: str) -> None:
        self.get(project_id)
        if self._stores is not None:
            self._stores.delete_all(project_id)
        self._projects.delete(project_id)
