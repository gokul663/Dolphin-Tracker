from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from dolphin_tracker.api.deps import get_project_service, get_routing_service
from dolphin_tracker.api.schemas import ProjectCreated
from dolphin_tracker.domain.models import Page, Project, ProjectCreate, RoutesBundle
from dolphin_tracker.services.projects import ProjectService
from dolphin_tracker.services.routing import RoutingService

router = APIRouter(prefix="/projects", tags=["projects"])
ServiceDep = Annotated[ProjectService, Depends(get_project_service)]
RoutingDep = Annotated[RoutingService, Depends(get_routing_service)]


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


@router.post(
    "",
    response_model=ProjectCreated,
    status_code=202,
    responses={201: {"model": ProjectCreated, "description": "Created without stops; no routing job"}},
)
def create_project(body: ProjectCreate, service: ServiceDep, response: Response) -> ProjectCreated:
    project, job_id = service.create(body)
    if job_id is None:
        response.status_code = 201
    return ProjectCreated(project=project, job_id=job_id)


@router.get("/{project_id}", response_model=Project)
def get_project(project_id: str, service: ServiceDep) -> Project:
    return service.get(project_id)


@router.get("/{project_id}/routes", response_model=RoutesBundle)
def get_routes(project_id: str, routing: RoutingDep) -> RoutesBundle:
    return routing.routes(project_id)


# Phase 2 (see docs/CHECKLIST.md): POST "" (202 + job), PATCH /{id}, DELETE /{id},
# POST /{id}/installers, POST /{id}/installers/rename, POST /{id}/routing/{rebalance|recluster} (jobs),
# POST /{id}/stops/{uid}/reassign (sync), GET /{id}/routes (bundle), POST /{id}/stops/append.
