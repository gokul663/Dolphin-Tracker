from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from dolphin_tracker.api.deps import SettingsDep, get_import_service, get_job_service
from dolphin_tracker.api.schemas import ImportJobCreate, ImportJobCreated, ImportMapping, ImportResult
from dolphin_tracker.domain.models import Job, JobView
from dolphin_tracker.services.imports import ImportService
from dolphin_tracker.services.jobs import JobService

router = APIRouter(prefix="/jobs", tags=["jobs"])
ServiceDep = Annotated[JobService, Depends(get_job_service)]
ImportDep = Annotated[ImportService, Depends(get_import_service)]


@router.post("/imports", response_model=ImportJobCreated, status_code=201)
def create_import(body: ImportJobCreate, service: ServiceDep) -> ImportJobCreated:
    try:
        job, upload_url = service.create_import(body.filename, body.content_type, body.project_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return ImportJobCreated(job_id=job.id, upload_url=upload_url, upload_key=job.payload["upload_key"])


@router.put("/{job_id}/upload", status_code=204, response_class=Response)
async def upload_local(job_id: str, request: Request, service: ServiceDep, settings: SettingsDep) -> Response:
    """Local mode only (DT_FILES_BUCKET empty): the raw file body. In AWS the browser PUTs to S3 and this is 404."""
    declared = int(request.headers.get("content-length") or 0)
    if declared > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="File too large")
    data = await request.body()
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="File too large")
    try:
        service.receive_upload(job_id, data)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return Response(status_code=204)


@router.post("/{job_id}/start", response_model=Job, status_code=202)
def start_job(job_id: str, service: ServiceDep) -> Job:
    try:
        return service.start(job_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/{job_id}", response_model=JobView)
def get_job(job_id: str, service: ServiceDep) -> JobView:
    return service.view(job_id)


@router.get("/{job_id}/result", response_model=ImportResult)
def get_result_local(job_id: str, service: ServiceDep) -> dict:
    """Local mode only: the import result document (§3.4). In AWS, follow `result_url` from GET /jobs/{id}."""
    return service.result(job_id)


@router.post("/{job_id}/mapping", response_model=ImportResult)
def remap_import(job_id: str, body: ImportMapping, imports: ImportDep) -> dict:
    """Apply a re-pointed column mapping to a finished import (no new geocoding) and return the new result."""
    return imports.remap(job_id, body.mapping)
