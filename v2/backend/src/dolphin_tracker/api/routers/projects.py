from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query

from dolphin_tracker.api.deps import get_project_service
from dolphin_tracker.domain.models import Page, Project
from dolphin_tracker.services.projects import ProjectService

router = APIRouter(prefix="/projects", tags=["projects"])
ServiceDep = Annotated[ProjectService, Depends(get_project_service)]


@router.get("", response_model=Page[Project])
def list_projects(
    service: ServiceDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: str | None = None,
) -> Page[Project]:
    try:
        return service.list(limit=limit, cursor=cursor)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{project_id}", response_model=Project)
def get_project(project_id: str, service: ServiceDep) -> Project:
    return service.get(project_id)


# Phase 2 (see docs/CHECKLIST.md): POST "" (202 + job), PATCH /{id}, DELETE /{id},
# POST /{id}/installers, POST /{id}/installers/rename, POST /{id}/routing/{rebalance|recluster} (jobs),
# POST /{id}/stops/{uid}/reassign (sync), GET /{id}/routes (bundle), POST /{id}/stops/append.
