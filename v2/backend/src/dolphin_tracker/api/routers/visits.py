from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query

from dolphin_tracker.api.auth import PrincipalDep
from dolphin_tracker.api.deps import get_visit_service
from dolphin_tracker.domain.auth import SERVICE_PROGRESS_FIELDS, store_edit_problem
from dolphin_tracker.domain.models import Page
from dolphin_tracker.domain.visits import StoreComment, StoreCommentInput, Visit, VisitInput
from dolphin_tracker.services.visits import VisitService

router = APIRouter(prefix="/projects/{project_id}/stores/{stop_uid}/visits", tags=["visits"])
comments_router = APIRouter(prefix="/projects/{project_id}/stores/{stop_uid}/comments", tags=["visits"])
ServiceDep = Annotated[VisitService, Depends(get_visit_service)]


@router.get("", response_model=Page[Visit])
def list_visits(
    project_id: str,
    stop_uid: str,
    service: ServiceDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: str | None = None,
) -> Page[Visit]:
    """The store's servicing history, newest first, every stick."""
    try:
        return service.list(project_id, stop_uid, limit=limit, cursor=cursor)
    except ValueError as exc:  # a bad cursor
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("", response_model=Visit, status_code=201)
def create_visit(project_id: str, stop_uid: str, body: VisitInput, service: ServiceDep) -> Visit:
    """Log one visit for one stick. Never changes status."""
    return service.create(project_id, stop_uid, body)


@comments_router.get("", response_model=Page[StoreComment])
def list_store_comments(
    project_id: str,
    stop_uid: str,
    service: ServiceDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: str | None = None,
) -> Page[StoreComment]:
    """The store's comments as log entries of their own, newest first."""
    try:
        return service.list_comments(project_id, stop_uid, limit=limit, cursor=cursor)
    except ValueError as exc:  # a bad cursor
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@comments_router.post("", response_model=StoreComment, status_code=201)
def add_store_comment(
    project_id: str, stop_uid: str, body: StoreCommentInput, service: ServiceDep, who: PrincipalDep
) -> StoreComment:
    """Log a comment on the store as a whole; it becomes the store's comment too. Held to the same rule as
    editing the comment (PATCH …/progress): someone who only logs visits, while the store is on a route."""
    problem = store_edit_problem(who, service.on_route(project_id, stop_uid), {"comment"}, SERVICE_PROGRESS_FIELDS)
    if problem:
        raise HTTPException(status_code=403, detail=problem)
    return service.add_comment(project_id, stop_uid, body, created_by=who.name or who.email)
