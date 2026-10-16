"""Lambda entry point for async jobs, invoked by the API with InvocationType=Event.

Event shape: {"job_id": "...", "job_type": "import_parse" | "routing_build", ...job-specific fields}
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from aws_lambda_powertools import Logger

from dolphin_tracker.domain.models import JobType
from dolphin_tracker.services.imports import ImportService
from dolphin_tracker.services.routing import RoutingService

logger = Logger()


def _run_import(event: dict[str, Any]) -> None:
    ImportService().run(event["job_id"], event)


def _run_routing(event: dict[str, Any]) -> None:
    RoutingService().run_build(event["project_id"])


RUNNERS: dict[JobType, Callable[[dict[str, Any]], None]] = {
    JobType.IMPORT_PARSE: _run_import,
    JobType.ROUTING_BUILD: _run_routing,
}


def dispatch(event: dict[str, Any]) -> dict[str, Any]:
    """Run one job event. Shared by the Lambda handler and the inline (local) invoker."""
    job_id = event.get("job_id", "")
    try:
        job_type = JobType(event["job_type"])
    except (KeyError, ValueError):
        logger.error("Unknown job type", extra={"event": event})
        return {"ok": False, "job_id": job_id, "error": "unknown job_type"}
    try:
        RUNNERS[job_type](event)
    except NotImplementedError as exc:
        logger.warning("Job runner not implemented", extra={"job_type": job_type, "detail": str(exc)})
        return {"ok": False, "job_id": job_id, "error": str(exc)}
    return {"ok": True, "job_id": job_id}


@logger.inject_lambda_context(log_event=True)
def handler(event: dict[str, Any], context) -> dict[str, Any]:
    return dispatch(event)
