"""Job lifecycle as seen by the API: create an import job, accept its upload, start it, report its status."""
from __future__ import annotations

from dolphin_tracker.domain.errors import ConflictError, NotFoundError
from dolphin_tracker.domain.models import Job, JobStatus
from dolphin_tracker.repositories.files import FileStore
from dolphin_tracker.repositories.jobs import JobRepository


class JobService:
    def __init__(self, jobs: JobRepository, files: FileStore) -> None:
        self._jobs = jobs
        self._files = files

    def get(self, job_id: str) -> Job:
        job = self._jobs.get(job_id)
        if job is None:
            raise NotFoundError(f"Job {job_id} not found")
        return job

    def receive_upload(self, job_id: str, data: bytes) -> None:
        """Local mode only: store the raw body where the presigned S3 PUT would have put it."""
        if not self._files.is_local:
            raise NotFoundError("Uploads go to the presigned S3 URL in this environment")
        job = self.get(job_id)
        key = job.payload.get("upload_key")
        if not key:
            raise NotFoundError(f"Job {job_id} takes no upload")
        if job.status != JobStatus.QUEUED:
            raise ConflictError(f"Job {job_id} has already started")
        if not data:
            raise ValueError("Empty upload")
        self._files.put_bytes(key, data, content_type=job.payload.get("content_type", "application/octet-stream"))
