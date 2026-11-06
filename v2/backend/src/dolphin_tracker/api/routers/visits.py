from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query

from dolphin_tracker.api.deps import get_visit_service
from dolphin_tracker.domain.models import Page
from dolphin_tracker.domain.visits import Visit, VisitInput
from dolphin_tracker.services.visits import VisitService

router = APIRouter(prefix="/projects/{project_id}/stores/{stop_uid}/visits", tags=["visits"])
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
