"""Job lifecycle as seen by the API: create an import job, accept its upload, start it, report its status."""
from __future__ import annotations

import uuid
from typing import Any

from aws_lambda_powertools import Logger

from dolphin_tracker.domain.errors import ConflictError, NotFoundError
from dolphin_tracker.domain.models import Job, JobStatus, JobType, JobView
from dolphin_tracker.repositories.files import FileStore, upload_key
from dolphin_tracker.repositories.jobs import JobRepository
from dolphin_tracker.repositories.projects import ProjectRepository
from dolphin_tracker.services.worker_invoker import WorkerInvoker

logger = Logger(child=True)

IMPORT_EXTENSIONS = (".csv", ".xlsx", ".xlsm", ".xltx", ".xltm")


class JobService:
    def __init__(
        self,
        jobs: JobRepository,
        files: FileStore,
        invoker: WorkerInvoker | None = None,
        projects: ProjectRepository | None = None,
    ) -> None:
        self._jobs = jobs
        self._files = files
        self._invoker = invoker
        self._projects = projects

    def get(self, job_id: str) -> Job:
        job = self._jobs.get(job_id)
        if job is None:
            raise NotFoundError(f"Job {job_id} not found")
        return job

    def view(self, job_id: str) -> JobView:
        job = self.get(job_id)
        result_url = None
        if job.status == JobStatus.SUCCEEDED and job.result_key:
            result_url = self._files.presign_download(job.result_key)
        return JobView(**job.model_dump(), result_url=result_url)

    def create_import(self, filename: str, content_type: str, project_id: str | None = None) -> tuple[Job, str]:
        """Mint an import job and the URL the browser uploads the sheet to. Returns (job, upload_url)."""
        if not filename.lower().endswith(IMPORT_EXTENSIONS):
            raise ValueError("Upload a .csv or .xlsx file")
        if project_id and self._projects is not None and self._projects.get(project_id) is None:
            raise NotFoundError(f"Project {project_id} not found")
        job_id = uuid.uuid4().hex
        key = upload_key(job_id, filename)
        job = Job(
            id=job_id,
            type=JobType.IMPORT_PARSE,
            project_id=project_id,
            message="Waiting for upload",
            payload={"upload_key": key, "filename": filename, "content_type": content_type},
        )
        self._jobs.put(job)
        return job, self._files.presign_upload(key, content_type)

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

    def start(self, job_id: str) -> Job:
        """Hand an uploaded import job to the worker. The queued→running transition is conditional, so a double
        click or a retry cannot start two workers for one job."""
        assert self._invoker is not None, "JobService.start needs a WorkerInvoker"
        job = self.get(job_id)
        if job.type != JobType.IMPORT_PARSE:
            raise ConflictError("Only import jobs are started by the client")
        if job.status != JobStatus.QUEUED:
            raise ConflictError(f"Job {job_id} has already started")
        key = job.payload.get("upload_key", "")
        if not key or not self._files.exists(key):
            raise ConflictError("The file has not been uploaded yet")
        started = self._jobs.set_status(
            job_id, JobStatus.RUNNING, progress=0, message="Starting", expected_status=JobStatus.QUEUED
        )
        event: dict[str, Any] = {
            "job_id": job_id,
            "job_type": JobType.IMPORT_PARSE.value,
            "project_id": job.project_id,
            "upload_key": key,
        }
        try:
            self._invoker.invoke(event)
        except Exception as exc:
            logger.exception("Could not invoke the worker", extra={"job_id": job_id})
            self._jobs.set_status(job_id, JobStatus.FAILED, message="Could not start the worker")
            raise RuntimeError("Could not start the worker") from exc
        return started

    def result(self, job_id: str) -> Any:
        """Local mode only: the stored result document (in AWS the client follows the presigned `result_url`)."""
        if not self._files.is_local:
            raise NotFoundError("Results are served from S3 in this environment")
        job = self.get(job_id)
        if job.status != JobStatus.SUCCEEDED or not job.result_key:
            raise NotFoundError(f"Job {job_id} has no result")
        return self._files.get_json(job.result_key)
