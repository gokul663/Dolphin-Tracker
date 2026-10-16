"""In-memory fakes for tests and local experiments. Same contracts as the DynamoDB implementations."""
from __future__ import annotations

from typing import Any

from dolphin_tracker.domain.errors import ConflictError, NotFoundError
from dolphin_tracker.domain.models import Page, Project, now_iso
from dolphin_tracker.repositories.dynamo import decode_cursor, encode_cursor
from dolphin_tracker.repositories.projects import IMMUTABLE_FIELDS


class InMemoryProjectRepository:
    def __init__(self) -> None:
        self._items: dict[str, Project] = {}

    def put(self, project: Project) -> None:
        self._items[project.id] = project.model_copy(deep=True)

    def get(self, project_id: str) -> Project | None:
        project = self._items.get(project_id)
        return project.model_copy(deep=True) if project else None

    def list(self, *, limit: int = 50, cursor: str | None = None) -> Page[Project]:
        ordered = sorted(self._items.values(), key=lambda project: project.created_at, reverse=True)
        start = int((decode_cursor(cursor) or {}).get("offset", 0))
        window = ordered[start : start + limit]
        next_cursor = encode_cursor({"offset": start + limit}) if start + limit < len(ordered) else None
        return Page(items=[project.model_copy(deep=True) for project in window], next_cursor=next_cursor)

    def update(self, project_id: str, changes: dict[str, Any], *, expected_version: int | None = None) -> Project:
        current = self._items.get(project_id)
        if current is None:
            raise NotFoundError(f"Project {project_id} not found")
        if expected_version is not None and current.version != expected_version:
            raise ConflictError(f"Project {project_id} was modified concurrently")
        data = current.model_dump()
        data.update({key: value for key, value in changes.items() if key not in IMMUTABLE_FIELDS})
        data["version"] = current.version + 1
        data["updated_at"] = now_iso()
        updated = Project.model_validate(data)
        self._items[project_id] = updated
        return updated.model_copy(deep=True)

    def delete(self, project_id: str) -> None:
        self._items.pop(project_id, None)
