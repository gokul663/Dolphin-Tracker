"""Hand a job event to the worker: async Lambda invoke in AWS, a background thread locally (DT_WORKER_MODE=inline).

Both modes deliver the same event shape (AGENT-HANDOFF §3.3) to the same dispatcher, so the services that run the
job are identical in both.
"""
from __future__ import annotations

import json
import threading
from collections.abc import Callable
from typing import Any, Protocol

from aws_lambda_powertools import Logger

from dolphin_tracker.config import Settings

logger = Logger(child=True)

JobEvent = dict[str, Any]


class WorkerInvoker(Protocol):
    def invoke(self, event: JobEvent) -> None: ...


class LambdaInvoker:
    """Fire-and-forget `InvocationType=Event` to the worker function."""

    def __init__(self, function_name: str, *, client: Any = None, region: str = "us-east-1") -> None:
        if not function_name:
            raise ValueError("DT_WORKER_FUNCTION_NAME is required when DT_WORKER_MODE=lambda")
        if client is None:
            import boto3  # local import: inline mode and tests never need the Lambda client

            client = boto3.client("lambda", region_name=region)
        self._client = client
        self._function_name = function_name

    def invoke(self, event: JobEvent) -> None:
        self._client.invoke(
            FunctionName=self._function_name, InvocationType="Event", Payload=json.dumps(event).encode()
        )


class InlineInvoker:
    """Run the dispatcher on a daemon thread inside the API process. Local development only."""

    def __init__(self, runner: Callable[[JobEvent], Any] | None = None) -> None:
        self._runner = runner
        self._threads: list[threading.Thread] = []

    def _run(self, event: JobEvent) -> None:
        runner = self._runner
        if runner is None:
            from dolphin_tracker.handlers.worker import dispatch  # deferred: the worker imports the services

            runner = dispatch
        try:
            runner(event)
        except Exception:  # the thread has no caller to report to; the job record carries the failure
            logger.exception("Inline job crashed", extra={"job_id": event.get("job_id")})

    def invoke(self, event: JobEvent) -> None:
        thread = threading.Thread(target=self._run, args=(event,), name=f"job-{event.get('job_id', '')}", daemon=True)
        self._threads.append(thread)
        thread.start()

    def wait(self, timeout: float = 30.0) -> None:
        """Join every started job thread (tests)."""
        for thread in self._threads:
            thread.join(timeout)


def make_invoker(settings: Settings) -> WorkerInvoker:
    if settings.worker_mode == "inline":
        return InlineInvoker()
    return LambdaInvoker(settings.worker_function_name, region=settings.aws_region)
