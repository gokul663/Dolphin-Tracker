"""Routing boundary around the v1 optimizer. The algorithm is unchanged; this adapts models in and out.

Concurrency (AGENT-HANDOFF §3.2): a build claims the project with `begin_routing` (or, on create, by writing
META already `building` with its job id). It writes only installer/day/seq diffs, then releases with
`finish_routing`, which succeeds only while the job still holds the slot. A superseded job stops without
touching the project again.
"""
from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from typing import Any

from aws_lambda_powertools import Logger

from dolphin_tracker.domain.errors import NotFoundError
from dolphin_tracker.domain.models import (
    InstallerStats,
    Job,
    JobStatus,
    JobType,
    Project,
    RoutesBundle,
    RoutingStatus,
    Stop,
)
from dolphin_tracker.domain.route_optimizer import build_project_routes, route_miles
from dolphin_tracker.repositories.jobs import JobRepository
from dolphin_tracker.repositories.projects import ProjectRepository
from dolphin_tracker.repositories.stores import StoreRepository
from dolphin_tracker.services.worker_invoker import WorkerInvoker

logger = Logger(child=True)

Assignment = tuple[str, int, int]  # installer, day (1-based), seq (0-based within the day)
STALE_BUILD = timedelta(minutes=20)
MODES = ("create", "recluster", "rebalance", "add_installer")
SUPERSEDED = "Superseded by a newer routing job"


def order_stops(stops: list[Stop]) -> list[Stop]:
    """Route order: installer, day, seq; display order breaks ties so the result is deterministic."""
    return sorted(stops, key=lambda stop: (stop.installer, stop.day, stop.seq, stop.display_id, stop.uid))


def group_routes(stops: list[Stop], installers: list[str]) -> dict[str, list[list[Stop]]]:
    """installer -> days (ascending day number, gaps collapsed as in v1) -> stops by seq."""
    by_installer: dict[str, dict[int, list[Stop]]] = {installer: defaultdict(list) for installer in installers}
    for stop in order_stops(stops):
        if stop.installer in by_installer:
            by_installer[stop.installer][stop.day].append(stop)
    return {installer: [days[day] for day in sorted(days)] for installer, days in by_installer.items()}


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
        routes = group_routes(self._stores.list_all(project_id), project.installers)
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
            installers=project.installers,
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

    def enqueue(self, project_id: str, mode: str, **payload: Any) -> Job:
        """Claim the project's routing slot and start a build. ConflictError (409) while one is running."""
        assert self._projects is not None and self._jobs is not None
        job = self.new_job(project_id, mode, **payload)
        self._jobs.put(job)
        stale_before = (datetime.now(UTC) - STALE_BUILD).isoformat()
        try:
            self._projects.begin_routing(project_id, job.id, stale_before=stale_before)
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
        if mode in ("create", "recluster"):
            return stops, self.build_assignments(stops, project.installers, project.stops_per_day)
        raise ValueError(f"Unsupported routing mode {mode!r}")

    def run_build(self, job_id: str) -> None:
        """Worker entry point for a routing_build job. Never raises: the outcome is on the job and project."""
        assert self._projects is not None and self._stores is not None and self._jobs is not None
        job = self._jobs.get(job_id)
        if job is None or not job.project_id:
            logger.warning("Routing job vanished before it ran", extra={"job_id": job_id})
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
