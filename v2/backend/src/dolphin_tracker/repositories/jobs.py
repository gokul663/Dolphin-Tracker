"""Async job records (imports, routing builds). Implemented in Phase 2."""
from __future__ import annotations

from typing import Protocol

from dolphin_tracker.domain.models import Job, JobStatus


class JobRepository(Protocol):
    def put(self, job: Job) -> None: ...
    def get(self, job_id: str) -> Job | None: ...
    def set_status(self, job_id: str, status: JobStatus, *, progress: int | None = None, message: str = "") -> Job: ...


class DynamoJobRepository:
    def __init__(self, table) -> None:
        self._table = table

    def put(self, job: Job) -> None:
        raise NotImplementedError("Phase 2: put_item with a 24h ttl attribute")

    def get(self, job_id: str) -> Job | None:
        raise NotImplementedError("Phase 2")

    def set_status(self, job_id: str, status: JobStatus, *, progress: int | None = None, message: str = "") -> Job:
        raise NotImplementedError("Phase 2")
