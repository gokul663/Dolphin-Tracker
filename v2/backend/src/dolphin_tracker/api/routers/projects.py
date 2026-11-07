from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from dolphin_tracker.api.deps import get_project_service, get_routing_service
from dolphin_tracker.api.schemas import (
    InstallerAdd,
    InstallerRename,
    JobAccepted,
    ProjectCreated,
    ProjectUpdate,
    ReassignResult,
    StopReassign,
)
from dolphin_tracker.domain.models import Page, Project, ProjectCreate, ProjectSummary, RoutesBundle
from dolphin_tracker.services.projects import ProjectService
from dolphin_tracker.services.routing import RoutingService

router = APIRouter(prefix="/projects", tags=["projects"])
ServiceDep = Annotated[ProjectService, Depends(get_project_service)]
RoutingDep = Annotated[RoutingService, Depends(get_routing_service)]


@router.get("", response_model=Page[ProjectSummary])
def list_projects(
    service: ServiceDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: str | None = None,
) -> Page[ProjectSummary]:
    try:
        return service.list(limit=limit, cursor=cursor)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post(
    "",
    response_model=ProjectCreated,
    status_code=201,
)
def create_project(body: ProjectCreate, service: ServiceDep) -> ProjectCreated:
    """Stores only: routing happens in route plans, so creating a project never starts a job."""
    project, skipped = service.create(body)
    return ProjectCreated(project=project, skipped=skipped)


@router.get("/{project_id}", response_model=ProjectSummary)
def get_project(project_id: str, service: ServiceDep) -> ProjectSummary:
    return service.summary(project_id)


@router.patch("/{project_id}", response_model=Project)
def update_project(project_id: str, body: ProjectUpdate, service: ServiceDep) -> Project:
    changes = body.model_dump(mode="json", exclude_unset=True, exclude={"expected_version"})
    try:
        return service.update(project_id, changes, expected_version=body.expected_version)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.delete("/{project_id}", status_code=204, response_class=Response)
def delete_project(
    project_id: str, service: ServiceDep, confirm: Annotated[str, Query(max_length=200)] = ""
) -> Response:
    try:
        service.delete(project_id, confirm=confirm)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return Response(status_code=204)


@router.get("/{project_id}/routes", response_model=RoutesBundle)
def get_routes(project_id: str, routing: RoutingDep) -> RoutesBundle:
    return routing.routes(project_id)


# Phase 2 (see docs/CHECKLIST.md): POST "" (202 + job), PATCH /{id}, DELETE /{id},
# POST /{id}/installers, POST /{id}/installers/rename, POST /{id}/routing/{rebalance|recluster} (jobs),
# POST /{id}/stops/{uid}/reassign (sync), GET /{id}/routes (bundle), POST /{id}/stops/append.


def _accepted(start) -> JobAccepted:
    try:
        return JobAccepted(job_id=start().id)
    except RuntimeError as exc:  # the worker could not be invoked; the job and project are marked failed
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/{project_id}/installers", response_model=JobAccepted, status_code=202)
def add_installer(project_id: str, body: InstallerAdd, routing: RoutingDep) -> JobAccepted:
    return _accepted(lambda: routing.add_installer(project_id, body.name))


@router.post("/{project_id}/installers/rename", response_model=Project)
def rename_installer(project_id: str, body: InstallerRename, routing: RoutingDep) -> Project:
    return routing.rename_installer(project_id, body.old_name, body.new_name)


@router.post("/{project_id}/routing/rebalance", response_model=JobAccepted, status_code=202)
def rebalance(project_id: str, routing: RoutingDep) -> JobAccepted:
    return _accepted(lambda: routing.rebalance(project_id))


@router.post("/{project_id}/routing/recluster", response_model=JobAccepted, status_code=202)
def recluster(project_id: str, routing: RoutingDep) -> JobAccepted:
    return _accepted(lambda: routing.recluster(project_id))


@router.post("/{project_id}/stops/{stop_uid}/reassign", response_model=ReassignResult)
def reassign_stop(project_id: str, stop_uid: str, body: StopReassign, routing: RoutingDep) -> dict:
    return routing.reassign(project_id, stop_uid, body.installer)
