"""In-memory fakes for tests and local experiments. Same contracts as the DynamoDB implementations."""
from __future__ import annotations

from typing import Any

from dolphin_tracker.domain.errors import ConflictError, NotFoundError
from dolphin_tracker.domain.models import Job, JobStatus, Page, Project, Stop, now_iso
from dolphin_tracker.repositories.dynamo import decode_cursor, encode_cursor
from dolphin_tracker.repositories.projects import IMMUTABLE_FIELDS
from dolphin_tracker.repositories.stores import IMMUTABLE_STOP_FIELDS, RoutingChange, check_routing_change


def _offset_page(items: list, limit: int, cursor: str | None) -> tuple[list, str | None]:
    start = int((decode_cursor(cursor) or {}).get("offset", 0))
    window = items[start : start + limit]
    next_cursor = encode_cursor({"offset": start + limit}) if start + limit < len(items) else None
    return window, next_cursor


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
        window, next_cursor = _offset_page(ordered, limit, cursor)
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


class InMemoryStoreRepository:
    def __init__(self) -> None:
        self._items: dict[str, dict[str, Stop]] = {}

    def put_many(self, project_id: str, stops: list[Stop]) -> None:
        bucket = self._items.setdefault(project_id, {})
        for stop in stops:
            bucket[stop.uid] = stop.model_copy(deep=True)

    def get(self, project_id: str, stop_uid: str) -> Stop | None:
        stop = self._items.get(project_id, {}).get(stop_uid)
        return stop.model_copy(deep=True) if stop else None

    def _ordered(self, project_id: str) -> list[Stop]:
        bucket = self._items.get(project_id, {})
        return [bucket[uid].model_copy(deep=True) for uid in sorted(bucket)]  # SK order, like the Query

    def list(self, project_id: str, *, limit: int = 50, cursor: str | None = None) -> Page[Stop]:
        window, next_cursor = _offset_page(self._ordered(project_id), limit, cursor)
        return Page(items=window, next_cursor=next_cursor)

    def list_all(self, project_id: str) -> list[Stop]:
        return self._ordered(project_id)

    def update_fields(self, project_id: str, stop_uid: str, changes: dict[str, Any]) -> Stop:
        current = self._items.get(project_id, {}).get(stop_uid)
        if current is None:
            raise NotFoundError(f"Stop {stop_uid} not found")
        data = current.model_dump()
        for key, value in changes.items():
            if key in IMMUTABLE_STOP_FIELDS:
                continue
            if "." in key:
                parent, child = key.split(".", 1)
                data[parent] = {**data.get(parent, {}), child: value}
            else:
                data[key] = value
        data["updated_at"] = now_iso()
        updated = Stop.model_validate(data)
        self._items[project_id][stop_uid] = updated
        return updated.model_copy(deep=True)

    def update_routing_many(self, project_id: str, changes: list[RoutingChange]) -> int:
        for _, change in changes:
            check_routing_change(change)
        written = 0
        for stop_uid, change in changes:
            if stop_uid in self._items.get(project_id, {}):
                self.update_fields(project_id, stop_uid, change)
                written += 1
        return written

    def delete_all(self, project_id: str) -> int:
        return len(self._items.pop(project_id, {}))


class InMemoryJobRepository:
    def __init__(self) -> None:
        self._items: dict[str, Job] = {}
        self.history: dict[str, list[JobStatus]] = {}  # status transitions, for tests

    def put(self, job: Job) -> None:
        self._items[job.id] = job.model_copy(deep=True)
        self.history.setdefault(job.id, []).append(job.status)

    def get(self, job_id: str) -> Job | None:
        job = self._items.get(job_id)
        return job.model_copy(deep=True) if job else None

    def _update(self, job_id: str, changes: dict[str, Any], *, expected_status: JobStatus | None = None) -> Job:
        current = self._items.get(job_id)
        if current is None:
            raise NotFoundError(f"Job {job_id} not found")
        if expected_status is not None and current.status != expected_status:
            raise ConflictError(f"Job {job_id} is no longer {expected_status.value}")
        updated = current.model_copy(update={**changes, "updated_at": now_iso()}, deep=True)
        self._items[job_id] = updated
        if self.history[job_id][-1] != updated.status:
            self.history[job_id].append(updated.status)
        return updated.model_copy(deep=True)

    def set_status(
        self,
        job_id: str,
        status: JobStatus,
        *,
        progress: int | None = None,
        message: str = "",
        expected_status: JobStatus | None = None,
    ) -> Job:
        changes: dict[str, Any] = {"status": status, "message": message}
        if progress is not None:
            changes["progress"] = max(0, min(100, progress))
        return self._update(job_id, changes, expected_status=expected_status)

    def set_result(self, job_id: str, result_key: str | None, *, message: str = "") -> Job:
        return self._update(
            job_id, {"status": JobStatus.SUCCEEDED, "progress": 100, "result_key": result_key, "message": message}
        )
