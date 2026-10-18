"""Routing boundary around the v1 optimizer. The algorithm is unchanged; this adapts models in and out.

Concurrency (AGENT-HANDOFF §3.2): a build claims the project with `begin_routing` (or, on create, by writing
META already `building` with its job id). It writes only installer/day/seq diffs, then releases with
`finish_routing`, which succeeds only while the job still holds the slot. A superseded job stops without
touching the project again.
"""
from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

from aws_lambda_powertools import Logger

from dolphin_tracker.domain.errors import ConflictError, NotFoundError, ValidationFailed
from dolphin_tracker.domain.models import (
    InstallerStats,
    Job,
    JobStatus,
    JobType,
    Project,
    RoutesBundle,
    RoutingStatus,
    Stop,
    StopStatus,
)
from dolphin_tracker.domain.route_optimizer import (
    build_project_routes,
    clean_territory_outliers,
    reassign_stop_preserving_days,
    rebalance_incomplete_routes,
    route_miles,
    split_territory_for_new_installer,
)
from dolphin_tracker.repositories.jobs import JobRepository
from dolphin_tracker.repositories.projects import ProjectRepository
from dolphin_tracker.repositories.stores import StoreRepository
from dolphin_tracker.repositories.worker_invoker import WorkerInvoker

logger = Logger(child=True)

Assignment = tuple[str, int, int]  # installer, day (1-based), seq (0-based within the day)
STALE_BUILD = timedelta(minutes=20)
MODES = ("create", "recluster", "rebalance", "add_installer")
SUPERSEDED = "Superseded by a newer routing job"
TERMINAL = frozenset({JobStatus.SUCCEEDED, JobStatus.FAILED})


def order_stops(stops: list[Stop]) -> list[Stop]:
    """Route order: installer, day, seq; display order breaks ties so the result is deterministic."""
    return sorted(stops, key=lambda stop: (stop.installer, stop.day, stop.seq, stop.display_id, stop.uid))


def route_installers(installers: list[str], stops: list[Stop]) -> list[str]:
    """The project's installers, then any other installer a stop is routed to (sorted), so no stop is hidden.

    Unlisted installers appear after a crash between the two writes of a rename, or in migrated v1 data."""
    listed = set(installers)
    return [*installers, *sorted({stop.installer for stop in stops if stop.installer and stop.installer not in listed})]


def group_routes(stops: list[Stop], installers: list[str]) -> dict[str, list[list[Stop]]]:
    """installer -> days (ascending day number, gaps collapsed as in v1) -> stops by seq."""
    by_installer: dict[str, dict[int, list[Stop]]] = {installer: defaultdict(list) for installer in installers}
    for stop in order_stops(stops):
        if stop.installer in by_installer:
            by_installer[stop.installer][stop.day].append(stop)
    return {installer: [days[day] for day in sorted(days)] for installer, days in by_installer.items()}


def optimizer_routes(stops: list[Stop], installers: list[str]) -> dict[str, list[list[dict[str, Any]]]]:
    """Current layout in the optimizer's shape (installer -> days -> row dicts), keyed by uid in `id`."""
    return {
        installer: [
            [
                {"id": stop.uid, "lat": stop.lat, "lng": stop.lng, "state": stop.state, "installer": installer,
                 "day": stop.day}
                for stop in day
            ]
            for day in days
        ]
        for installer, days in group_routes(stops, installers).items()
    }


def day_miles(day: list[Stop]) -> float:
    """Straight-line miles along the day in seq order, over the stops that have coordinates."""
    located = [{"lat": stop.lat, "lng": stop.lng} for stop in day if stop.lat is not None and stop.lng is not None]
    return route_miles(located)


class RoutingService:
    def __init__(
        self,
        projects: ProjectRepository | None = None,
        stores: StoreRepository | None = None,
        jobs: JobRepository | None = None,
        invoker: WorkerInvoker | None = None,
    ) -> None:
        self._projects = projects
        self._stores = stores
        self._jobs = jobs
        self._invoker = invoker

    # ---- pure helpers -------------------------------------------------------------------------------------

    @staticmethod
    def build_assignments(stops: list[Stop], installers: list[str], per_day: int) -> dict[str, Assignment]:
        """Run the optimizer over the given stops. Returns uid -> (installer, day, seq). Pure and synchronous."""
        rows = [{"id": stop.uid, "lat": stop.lat, "lng": stop.lng, "state": stop.state} for stop in stops]
        routes = build_project_routes(rows, installers, per_day)
        return RoutingService.assignments_from_routes(routes)

    @staticmethod
    def assignments_from_routes(routes: dict[str, list[list[dict[str, Any]]]]) -> dict[str, Assignment]:
        assignments: dict[str, Assignment] = {}
        for installer, days in routes.items():
            for day_number, day in enumerate(days, start=1):
                for seq, row in enumerate(day):
                    assignments[str(row["id"])] = (installer, day_number, seq)
        return assignments

    @staticmethod
    def diff(stops: list[Stop], assignments: dict[str, Assignment]) -> list[tuple[str, dict[str, object]]]:
        """Only the stops whose (installer, day, seq) changed. Progress fields are never part of a routing write."""
        changes: list[tuple[str, dict[str, object]]] = []
        for stop in stops:
            installer, day, seq = assignments.get(stop.uid, (stop.installer, stop.day, stop.seq))
            if (installer, day, seq) != (stop.installer, stop.day, stop.seq):
                changes.append((stop.uid, {"installer": installer, "day": day, "seq": seq}))
        return changes

    # ---- reads --------------------------------------------------------------------------------------------

    def _project(self, project_id: str) -> Project:
        assert self._projects is not None
        project = self._projects.get(project_id)
        if project is None:
            raise NotFoundError(f"Project {project_id} not found")
        return project

    def routes(self, project_id: str) -> RoutesBundle:
        assert self._stores is not None
        project = self._project(project_id)
        stops = self._stores.list_all(project_id)
        installers = route_installers(project.installers, stops)
        routes = group_routes(stops, installers)
        stats = {}
        for installer, days in routes.items():
            total = sum(len(day) for day in days)
            stats[installer] = InstallerStats(
                total=total,
                days=len(days),
                avg_stops=round(total / len(days), 1) if days else 0,
                miles=round(sum(day_miles(day) for day in days), 1),
            )
        return RoutesBundle(
            installers=installers,
            stops_per_day=project.stops_per_day,
            routing_status=project.routing_status,
            routes=routes,
            stats=stats,
        )

    # ---- enqueue (API side) -------------------------------------------------------------------------------

    @staticmethod
    def new_job(project_id: str, mode: str, **payload: Any) -> Job:
        if mode not in MODES:
            raise ValueError(f"Unknown routing mode {mode!r}")
        return Job(
            id=uuid.uuid4().hex,
            type=JobType.ROUTING_BUILD,
            project_id=project_id,
            message="Waiting for worker",
            payload={"mode": mode, **payload},
        )

    @staticmethod
    def _stale_before() -> str:
        return (datetime.now(UTC) - STALE_BUILD).isoformat()

    def enqueue(self, project_id: str, mode: str, *, installers: list[str] | None = None, **payload: Any) -> Job:
        """Claim the project's routing slot and start a build. ConflictError (409) while one is running.

        `installers`, when given, replaces the project's installer list in the same conditional write."""
        assert self._projects is not None and self._jobs is not None
        job = self.new_job(project_id, mode, **payload)
        self._jobs.put(job)
        try:
            self._projects.begin_routing(
                project_id, job.id, stale_before=self._stale_before(), installers=installers
            )
        except Exception as exc:
            self._jobs.set_status(job.id, JobStatus.FAILED, message=str(exc))
            raise
        self.launch(job)
        return job

    def record_and_launch(self, job: Job) -> None:
        """For a job whose id was written into META directly (project create): record it, then launch it."""
        assert self._jobs is not None
        self._jobs.put(job)
        self.launch(job)

    def launch(self, job: Job) -> None:
        """Send an already-recorded routing job (whose id holds the project's slot) to the worker."""
        assert self._projects is not None and self._jobs is not None and self._invoker is not None
        event = {
            "job_id": job.id,
            "job_type": JobType.ROUTING_BUILD.value,
            "project_id": job.project_id,
            **job.payload,
        }
        try:
            self._invoker.invoke(event)
        except Exception as exc:
            logger.exception("Could not invoke the worker", extra={"job_id": job.id})
            self._jobs.set_status(job.id, JobStatus.FAILED, message="Could not start the worker")
            self._projects.finish_routing(job.project_id or "", job.id, RoutingStatus.FAILED)
            raise RuntimeError("Could not start the worker") from exc

    # ---- build (worker side) ------------------------------------------------------------------------------

    def _assignments(self, mode: str, project: Project, stops: list[Stop], payload: dict[str, Any]):
        """(stops that were re-planned, uid -> assignment) for one build mode."""
        if mode in ("create", "recluster"):
            return stops, self.build_assignments(stops, project.installers, project.stops_per_day)
        if mode in ("rebalance", "add_installer"):
            new_installer = payload.get("new_installer") if mode == "add_installer" else None
            return self.rebalance_assignments(project, stops, new_installer)
        raise ValueError(f"Unsupported routing mode {mode!r}")

    @classmethod
    def rebalance_assignments(
        cls, project: Project, stops: list[Stop], new_installer: str | None = None
    ) -> tuple[list[Stop], dict[str, Assignment]]:
        """Port of v1 `rebalance_project_incomplete`, keyed by uid: only Incomplete stops move; completed and other
        stops keep their installer and day. With `new_installer`, the busiest territory is split to give it one
        coherent cluster first."""
        installers = project.installers
        current = optimizer_routes(stops, installers)
        incomplete = {stop.uid for stop in stops if stop.status == StopStatus.INCOMPLETE}
        if new_installer:
            existing = [name for name in installers if name != new_installer]
            override = split_territory_for_new_installer(current, incomplete, existing, new_installer)
        else:
            override = clean_territory_outliers(current, incomplete, installers)
        rerouted = rebalance_incomplete_routes(current, incomplete, installers, project.stops_per_day, override)
        return [stop for stop in stops if stop.uid in incomplete], cls.assignments_from_routes(rerouted)

    # ---- synchronous operations (API side) ----------------------------------------------------------------

    @contextmanager
    def _sync_slot(self, project: Project) -> Iterator[None]:
        """Hold the routing slot for a short synchronous edit, so no build starts (or runs) underneath it.
        The previous status comes back afterwards (a `failed` build stays visible as failed)."""
        assert self._projects is not None
        token = f"sync-{uuid.uuid4().hex}"
        previous = RoutingStatus.READY if project.routing_status == RoutingStatus.BUILDING else project.routing_status
        self._projects.begin_routing(project.id, token, stale_before=self._stale_before())
        try:
            yield
        finally:
            self._projects.finish_routing(project.id, token, previous)

    def add_installer(self, project_id: str, name: str) -> Job:
        project = self._project(project_id)
        name = name.strip()
        if not name:
            raise ValidationFailed("Installer name cannot be empty")
        if name in project.installers:
            raise ConflictError("Installer name already exists")
        return self.enqueue(
            project_id, "add_installer", installers=[*project.installers, name], new_installer=name
        )

    def rebalance(self, project_id: str) -> Job:
        project = self._project(project_id)
        if not project.installers:
            raise ValidationFailed("At least one installer is required")
        return self.enqueue(project_id, "rebalance")

    def recluster(self, project_id: str) -> Job:
        project = self._project(project_id)
        if not project.installers:
            raise ValidationFailed("At least one installer is required")
        return self.enqueue(project_id, "recluster")

    def rename_installer(self, project_id: str, old_name: str, new_name: str) -> Project:
        """Rewrite the name on META and on every stop. `installer` (routing group) and `installer_name` (progress
        group, only where it equalled the old name) go out as separate writes (rule 5)."""
        assert self._projects is not None and self._stores is not None
        project = self._project(project_id)
        old_name, new_name = old_name.strip(), new_name.strip()
        if old_name not in project.installers:
            raise NotFoundError("Installer not found")
        if not new_name:
            raise ValidationFailed("Installer name cannot be empty")
        if new_name == old_name:
            return project
        if new_name in project.installers:
            raise ConflictError("Installer name already exists")
        with self._sync_slot(project):
            renamed = [new_name if name == old_name else name for name in project.installers]
            self._projects.update(project_id, {"installers": renamed})
            stops = self._stores.list_all(project_id)
            self._stores.update_routing_many(
                project_id, [(stop.uid, {"installer": new_name}) for stop in stops if stop.installer == old_name]
            )
            for stop in stops:
                if stop.installer_name == old_name:
                    self._stores.update_fields(project_id, stop.uid, {"installer_name": new_name})
        return self._project(project_id)

    def reassign(self, project_id: str, stop_uid: str, installer: str) -> dict[str, Any]:
        """Move one stop to another installer, keeping every unrelated stop on its day (v1, synchronous)."""
        assert self._stores is not None
        project = self._project(project_id)
        if installer not in project.installers:
            raise ValidationFailed("Installer is not assigned to this project")
        with self._sync_slot(project):
            stops = self._stores.list_all(project_id)
            stop = next((item for item in stops if item.uid == stop_uid), None)
            if stop is None:
                raise NotFoundError(f"Stop {stop_uid} not found")
            # Unassigned stops ride along under "" so they can be moved too; that bucket's layout is ignored.
            routes = optimizer_routes(stops, [*route_installers(project.installers, stops), ""])
            try:
                rerouted, _, old_installer = reassign_stop_preserving_days(
                    routes, stop_uid, installer, project.stops_per_day
                )
            except KeyError:  # target not in the routes; unreachable after the check above, kept distinct
                raise
            except LookupError as exc:  # the optimizer's "Stop not found"
                raise NotFoundError(f"Stop {stop_uid} not found") from exc
            assignments = {
                uid: assignment
                for uid, assignment in self.assignments_from_routes(rerouted).items()
                if assignment[0] != ""
            }
            changes = self.diff(stops, assignments)
            self._stores.update_routing_many(project_id, changes)
        return {"old_installer": old_installer, "installer": installer, "changed": [uid for uid, _ in changes]}

    def run_build(self, job_id: str) -> None:
        """Worker entry point for a routing_build job. Never raises: the outcome is on the job and project."""
        assert self._projects is not None and self._stores is not None and self._jobs is not None
        job = self._jobs.get(job_id)
        if job is None or not job.project_id:
            logger.warning("Routing job vanished before it ran", extra={"job_id": job_id})
            return
        if job.status in TERMINAL:  # Lambda async invoke is at-least-once: a redelivered event is a no-op
            logger.info("Routing job already finished; ignoring redelivery", extra={"job_id": job_id})
            return
        project_id = job.project_id
        mode = job.payload.get("mode", "")
        try:
            self._jobs.set_status(job_id, JobStatus.RUNNING, progress=5, message=f"Routing ({mode})")
            project = self._project(project_id)
            if project.routing_job_id != job_id:
                logger.info("Routing job superseded before start", extra={"job_id": job_id})
                self._jobs.set_status(job_id, JobStatus.FAILED, message=SUPERSEDED)
                return
            stops = self._stores.list_all(project_id)
            routed, assignments = self._assignments(mode, project, stops, job.payload)
            changes = self.diff(stops, assignments)
            self._jobs.set_status(job_id, JobStatus.RUNNING, progress=70, message=f"Saving {len(changes)} moves")

            # Last cheap check before writing: a newer job may have claimed the slot while we computed.
            current = self._projects.get(project_id)
            if current is None or current.routing_job_id != job_id:
                logger.info("Routing job superseded during compute", extra={"job_id": job_id})
                self._jobs.set_status(job_id, JobStatus.FAILED, message=SUPERSEDED)
                return
            written = self._stores.update_routing_many(project_id, changes)
            for stop in routed:  # a separate, non-routing write: the rebuilt stops are no longer stale
                if stop.route_stale:
                    self._stores.update_fields(project_id, stop.uid, {"route_stale": False})

            if not self._projects.finish_routing(project_id, job_id, RoutingStatus.READY):
                logger.info("Routing job superseded at finish", extra={"job_id": job_id})
                self._jobs.set_status(job_id, JobStatus.FAILED, message=SUPERSEDED)
                return
            self._jobs.set_result(job_id, None, message=f"{written} of {len(stops)} stops moved")
            logger.info("Routing finished", extra={"job_id": job_id, "mode": mode, "moved": written})
        except Exception as exc:
            logger.exception("Routing failed", extra={"job_id": job_id})
            try:
                self._projects.finish_routing(project_id, job_id, RoutingStatus.FAILED)
                self._jobs.set_status(job_id, JobStatus.FAILED, message=f"Routing failed: {exc}")
            except Exception:
                logger.exception("Could not record routing failure", extra={"job_id": job_id})
