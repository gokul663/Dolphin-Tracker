from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from dolphin_tracker.api.deps import SettingsDep, get_job_service
from dolphin_tracker.services.jobs import JobService

router = APIRouter(prefix="/jobs", tags=["jobs"])
ServiceDep = Annotated[JobService, Depends(get_job_service)]


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
