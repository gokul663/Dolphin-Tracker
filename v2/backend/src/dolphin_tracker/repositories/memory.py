"""In-memory fakes for tests and local experiments. Same contracts as the DynamoDB implementations."""
from __future__ import annotations

from typing import Any

from dolphin_tracker.domain.cursors import encode_cursor, offset_from_cursor
from dolphin_tracker.domain.errors import ConflictError, NotFoundError
from dolphin_tracker.domain.lists import Category, NameEntry, NameListKind, name_key
from dolphin_tracker.domain.models import Job, JobStatus, Page, Project, RoutingStatus, Screen, Stop, now_iso
from dolphin_tracker.domain.route_plans import PlanStatus, PlanStop, RoutePlan
from dolphin_tracker.domain.visits import Visit
from dolphin_tracker.repositories.projects import IMMUTABLE_FIELDS
from dolphin_tracker.repositories.route_plans import PlanStopChange, check_assignment
from dolphin_tracker.repositories.stores import (
    IMMUTABLE_STOP_FIELDS,
    RoutingChange,
    check_progress_change,
    check_routing_change,
    screens_write,
)


def _offset_page(items: list, limit: int, cursor: str | None) -> tuple[list, str | None]:
    start = offset_from_cursor(cursor)
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

    def begin_routing(
        self, project_id: str, job_id: str, *, stale_before: str, add_installer: str | None = None
    ) -> Project:
        current = self._items.get(project_id)
        if current is None:
            raise NotFoundError(f"Project {project_id} not found")
        if current.routing_status == RoutingStatus.BUILDING and current.updated_at >= stale_before:
            raise ConflictError("Routing is already in progress for this project")
        changes: dict[str, Any] = {
            "routing_status": RoutingStatus.BUILDING, "routing_job_id": job_id, "updated_at": now_iso()
        }
        if add_installer is not None:
            if add_installer in current.installers:
                raise ConflictError("Installer name already exists")
            changes["installers"] = [*current.installers, add_installer]  # append to the current list, like Dynamo
        updated = current.model_copy(update=changes)
        self._items[project_id] = updated
        return updated.model_copy(deep=True)

    def finish_routing(self, project_id: str, job_id: str, status: RoutingStatus) -> bool:
        current = self._items.get(project_id)
        if current is None or current.routing_job_id != job_id:
            return False
        self._items[project_id] = current.model_copy(
            update={"routing_status": status, "routing_job_id": "", "updated_at": now_iso()}
        )
        return True


class InMemoryStoreRepository:
    def __init__(self) -> None:
        self._items: dict[str, dict[str, Stop]] = {}
        self._markers: dict[str, dict[str, str]] = {}  # project → IBC# → stop uid, like the EXT# items

    def put_many(self, project_id: str, stops: list[Stop]) -> None:
        markers = self._markers.setdefault(project_id, {})
        ids = [stop.external_id for stop in stops if stop.external_id]
        if len(set(ids)) != len(ids):
            raise ConflictError("IBC# appears twice in this write")
        bucket = self._items.setdefault(project_id, {})
        for stop in stops:  # per stop, stop + marker together (Dynamo commits 50 at a time)
            if stop.external_id and markers.get(stop.external_id, stop.uid) != stop.uid:
                raise ConflictError(f"IBC# {stop.external_id} already exists in this project")
            bucket[stop.uid] = stop.model_copy(deep=True)
            if stop.external_id:
                markers[stop.external_id] = stop.uid

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

    def update_progress_many(self, project_id: str, changes: list[RoutingChange]) -> int:
        for _, change in changes:
            check_progress_change(change)
        written = 0
        for stop_uid, change in changes:
            if stop_uid in self._items.get(project_id, {}):
                self.update_fields(project_id, stop_uid, change)
                written += 1
        return written

    def update_screens(self, project_id: str, stop_uid: str, screens: list[Screen], *, updated_by: str = "") -> Stop:
        return self.update_fields(project_id, stop_uid, screens_write(screens, updated_by))

    def delete_all(self, project_id: str) -> int:
        self._markers.pop(project_id, None)
        return len(self._items.pop(project_id, {}))

    def list_projected(self, project_id: str, attributes: tuple[str, ...]) -> list[dict[str, Any]]:
        return [
            {key: value for key, value in stop.model_dump(mode="json").items() if key in attributes}
            for stop in self._ordered(project_id)
        ]

    def claim_for_plan(self, project_id: str, stop_uids: list[str], plan_id: str, at: str) -> list[str]:
        bucket = self._items.get(project_id, {})
        claimed = []
        for uid in stop_uids:
            stop = bucket.get(uid)
            if stop is None or stop.route_plan_id:
                continue
            bucket[uid] = stop.model_copy(update={"route_plan_id": plan_id, "last_planned_at": at})
            claimed.append(uid)
        return claimed

    def release_from_plan(self, project_id: str, stop_uids: list[str], plan_id: str) -> int:
        bucket = self._items.get(project_id, {})
        released = 0
        for uid in stop_uids:
            stop = bucket.get(uid)
            if stop is not None and stop.route_plan_id == plan_id:
                bucket[uid] = stop.model_copy(update={"route_plan_id": ""})
                released += 1
        return released


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


class InMemoryListRepository:
    def __init__(self) -> None:
        self._names: dict[NameListKind, dict[str, NameEntry]] = {}
        self._categories: list[Category] | None = None

    def list_names(self, kind: NameListKind, *, limit: int = 200, cursor: str | None = None) -> Page[NameEntry]:
        bucket = self._names.get(kind, {})
        ordered = [bucket[key].model_copy() for key in sorted(bucket)]
        window, next_cursor = _offset_page(ordered, limit, cursor)
        return Page(items=window, next_cursor=next_cursor)

    def add_name(self, kind: NameListKind, value: str) -> NameEntry:
        bucket = self._names.setdefault(kind, {})
        key = name_key(value)
        if key not in bucket:
            bucket[key] = NameEntry(value=value, created_at=now_iso())
        return bucket[key].model_copy()

    def delete_name(self, kind: NameListKind, value: str) -> None:
        self._names.get(kind, {}).pop(name_key(value), None)

    def get_categories(self) -> list[Category] | None:
        return None if self._categories is None else [category.model_copy(deep=True) for category in self._categories]

    def put_categories(self, categories: list[Category]) -> None:
        self._categories = [category.model_copy(deep=True) for category in categories]


class InMemoryVisitRepository:
    """Shares the store fake, so the per-stick summary lands on the same stops the services read."""

    def __init__(self, stores: InMemoryStoreRepository) -> None:
        self._stores = stores
        self._items: list[Visit] = []

    def add(self, visit: Visit) -> Visit:
        stop = self._stores.get(visit.project_id, visit.stop_uid)
        if stop is None:
            raise NotFoundError(f"Stop {visit.stop_uid} not found")
        self._items.append(visit.model_copy(deep=True))
        bucket = self._stores._items[visit.project_id]  # bypasses update_fields: a visit is not an edit
        bucket[visit.stop_uid] = stop.model_copy(update={
            "screen_visits": {**stop.screen_visits, visit.screen_id: visit.created_at},
            "last_visit_at": visit.created_at,
        })
        return visit

    def list_for_store(
        self, project_id: str, stop_uid: str, *, limit: int = 50, cursor: str | None = None
    ) -> Page[Visit]:
        mine = [v for v in self._items if v.project_id == project_id and v.stop_uid == stop_uid]
        mine.sort(key=lambda v: (v.created_at, v.id), reverse=True)
        window, next_cursor = _offset_page([v.model_copy(deep=True) for v in mine], limit, cursor)
        return Page(items=window, next_cursor=next_cursor)


class InMemoryRoutePlanRepository:
    def __init__(self) -> None:
        self._plans: dict[str, RoutePlan] = {}
        self._stops: dict[str, dict[str, PlanStop]] = {}

    def put(self, plan: RoutePlan) -> None:
        self._plans[plan.id] = plan.model_copy(deep=True)

    def get(self, plan_id: str) -> RoutePlan | None:
        plan = self._plans.get(plan_id)
        return plan.model_copy(deep=True) if plan else None

    def list(self, status: PlanStatus, *, limit: int = 50, cursor: str | None = None) -> Page[RoutePlan]:
        mine = sorted((p for p in self._plans.values() if p.status == status), key=lambda p: p.created_at,
                      reverse=True)
        window, next_cursor = _offset_page([p.model_copy(deep=True) for p in mine], limit, cursor)
        return Page(items=window, next_cursor=next_cursor)

    def update(self, plan_id: str, changes: dict[str, Any], *, expected_version: int | None = None) -> RoutePlan:
        current = self._plans.get(plan_id)
        if current is None:
            raise NotFoundError(f"Route plan {plan_id} not found")
        if expected_version is not None and current.version != expected_version:
            raise ConflictError("The plan was changed by someone else; reload it and try again")
        data = current.model_dump()
        data.update({k: v for k, v in changes.items() if k not in {"id", "version", "created_at"}})
        data.update(version=current.version + 1, updated_at=now_iso())
        updated = RoutePlan.model_validate(data)
        self._plans[plan_id] = updated
        return updated.model_copy(deep=True)

    def put_stops(self, plan_id: str, stops: list[PlanStop]) -> None:
        bucket = self._stops.setdefault(plan_id, {})
        for stop in stops:
            bucket[stop.key] = stop.model_copy(deep=True)

    def list_stops(self, plan_id: str) -> list[PlanStop]:
        bucket = self._stops.get(plan_id, {})
        return [bucket[key].model_copy(deep=True) for key in sorted(bucket)]

    def get_stop(self, plan_id: str, key: str) -> PlanStop | None:
        stop = self._stops.get(plan_id, {}).get(key)
        return stop.model_copy(deep=True) if stop else None

    def update_assignments(self, plan_id: str, changes: list[PlanStopChange]) -> int:
        for _, change in changes:
            check_assignment(change)
        bucket = self._stops.get(plan_id, {})
        written = 0
        for key, change in changes:
            if key in bucket:
                bucket[key] = bucket[key].model_copy(update=change)
                written += 1
        return written

    def delete_stop(self, plan_id: str, key: str) -> None:
        self._stops.get(plan_id, {}).pop(key, None)

    def record_visit(self, plan_id: str, key: str, screen_id: str) -> PlanStop | None:
        stop = self._stops.get(plan_id, {}).get(key)
        if stop is None:
            return None
        if screen_id not in stop.visited_screens:
            stop = stop.model_copy(update={"visited_screens": [*stop.visited_screens, screen_id]})
            self._stops[plan_id][key] = stop
        return stop.model_copy(deep=True)
