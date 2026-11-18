"""The sheets a project was built from: each import that reaches a project (create or append) keeps its file for
good and is listed in Settings, with a download link."""
from __future__ import annotations

from aws_lambda_powertools import Logger

from dolphin_tracker.domain.base import ApiModel
from dolphin_tracker.domain.errors import NotFoundError
from dolphin_tracker.domain.models import Project, ProjectUpload
from dolphin_tracker.repositories.files import FileStore, project_upload_key
from dolphin_tracker.repositories.jobs import JobRepository
from dolphin_tracker.repositories.projects import ProjectRepository

logger = Logger(child=True)

MAX_UPLOADS = 200  # kept on the project item; the oldest entries drop off the list (their files stay)


class UploadView(ProjectUpload):
    download_url: str


class UploadList(ApiModel):
    items: list[UploadView]  # newest first


class UploadService:
    def __init__(self, projects: ProjectRepository, jobs: JobRepository, files: FileStore) -> None:
        self._projects = projects
        self._jobs = jobs
        self._files = files

    def _project(self, project_id: str) -> Project:
        project = self._projects.get(project_id)
        if project is None:
            raise NotFoundError(f"Project {project_id} not found")
        return project

    def record(self, project_id: str, job_id: str, *, kind: str, submitted: int, added: int, skipped: int) -> None:
        """Keep the import job's sheet with the project. Never fails the import it follows: a problem here is
        logged and the stores stay."""
        if not job_id:
            return
        try:
            job = self._jobs.get(job_id)
            source = (job.payload.get("upload_key") if job else "") or ""
            if not source or not self._files.exists(source):
                return
            project = self._project(project_id)
            if any(upload.id == job_id for upload in project.uploads):
                return  # a retried request
            filename = job.payload.get("filename") or source.rsplit("/", 1)[-1]
            data = self._files.get_bytes(source)
            key = project_upload_key(project_id, job_id, filename)
            # A copy outside `uploads/`, which expires: abandoned uploads still clean themselves up.
            self._files.put_bytes(key, data, content_type=job.payload.get("content_type", "application/octet-stream"))
            upload = ProjectUpload(id=job_id, filename=filename, key=key, kind=kind, size=len(data),
                                   submitted=submitted, added=added, skipped=skipped)
            uploads = [*project.uploads, upload][-MAX_UPLOADS:]
            self._projects.update(project_id, {"uploads": [item.model_dump(mode="json") for item in uploads]})
        except Exception:
            logger.exception("Could not keep the uploaded sheet", extra={"project_id": project_id, "job_id": job_id})

    def list(self, project_id: str) -> UploadList:
        project = self._project(project_id)
        return UploadList(items=[
            UploadView(**upload.model_dump(),
                       download_url=self._files.presign_download(upload.key, download_name=upload.filename))
            for upload in reversed(project.uploads)
        ])

    def file(self, project_id: str, upload_id: str) -> tuple[ProjectUpload, bytes]:
        """Local mode only: the file itself (in AWS the list's `download_url` points at S3)."""
        if not self._files.is_local:
            raise NotFoundError("Uploads are served from S3 in this environment")
        upload = next((item for item in self._project(project_id).uploads if item.id == upload_id), None)
        if upload is None or not self._files.exists(upload.key):
            raise NotFoundError("That upload is not in this project")
        return upload, self._files.get_bytes(upload.key)
