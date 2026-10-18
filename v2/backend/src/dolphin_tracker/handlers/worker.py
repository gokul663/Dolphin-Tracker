"""Lambda entry point for async jobs, invoked by the API with InvocationType=Event.

Event shape: {"job_id": "...", "job_type": "import_parse" | "routing_build", ...job-specific fields}
Locally (DT_WORKER_MODE=inline) the API calls `dispatch` on a thread with the same event.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from aws_lambda_powertools import Logger

from dolphin_tracker.config import get_settings, resolve_google_server_key
from dolphin_tracker.domain.models import JobType
from dolphin_tracker.repositories.dynamo import get_table
from dolphin_tracker.repositories.files import FileStore, make_file_store
from dolphin_tracker.repositories.jobs import DynamoJobRepository, JobRepository
from dolphin_tracker.repositories.projects import DynamoProjectRepository, ProjectRepository
from dolphin_tracker.repositories.stores import DynamoStoreRepository, StoreRepository
from dolphin_tracker.services.geocoding import GoogleGeocoder
from dolphin_tracker.services.imports import ImportService
from dolphin_tracker.services.routing import RoutingService

logger = Logger()


@dataclass
class WorkerDeps:
    jobs: JobRepository
    projects: ProjectRepository
    stores: StoreRepository
    files: FileStore
    geocoder_factory: Callable[[], Any]  # a fresh geocoder per job; closed when the job ends


@lru_cache
def default_deps() -> WorkerDeps:
    settings = get_settings()
    table = get_table(settings)
    return WorkerDeps(
        jobs=DynamoJobRepository(table),
        projects=DynamoProjectRepository(table),
        stores=DynamoStoreRepository(table),
        files=make_file_store(settings),
        geocoder_factory=lambda: GoogleGeocoder(resolve_google_server_key(settings)),
    )


def _run_import(event: dict[str, Any], deps: WorkerDeps) -> None:
    geocoder = deps.geocoder_factory()
    try:
        ImportService(deps.jobs, deps.files, geocoder, deps.projects).run(event["job_id"], event)
    finally:
        close = getattr(geocoder, "close", None)
        if close:
            close()


def _run_routing(event: dict[str, Any], deps: WorkerDeps) -> None:
    RoutingService(deps.projects, deps.stores, deps.jobs).run_build(event["job_id"])


RUNNERS: dict[JobType, Callable[[dict[str, Any], WorkerDeps], None]] = {
    JobType.IMPORT_PARSE: _run_import,
    JobType.ROUTING_BUILD: _run_routing,
}


def dispatch(event: dict[str, Any], deps: WorkerDeps | None = None) -> dict[str, Any]:
    """Run one job event. Shared by the Lambda handler and the inline (local) invoker."""
    job_id = event.get("job_id", "")
    try:
        job_type = JobType(event["job_type"])
    except (KeyError, ValueError):
        logger.error("Unknown job type", extra={"event": event})
        return {"ok": False, "job_id": job_id, "error": "unknown job_type"}
    try:
        RUNNERS[job_type](event, deps or default_deps())
    except NotImplementedError as exc:
        logger.warning("Job runner not implemented", extra={"job_type": job_type, "detail": str(exc)})
        return {"ok": False, "job_id": job_id, "error": str(exc)}
    return {"ok": True, "job_id": job_id}


@logger.inject_lambda_context(log_event=True)
def handler(event: dict[str, Any], context) -> dict[str, Any]:
    return dispatch(event)
