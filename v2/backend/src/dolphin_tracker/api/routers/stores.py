from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from dolphin_tracker.api.deps import get_store_service
from dolphin_tracker.api.schemas import Pin, ProgressUpdate, StoreDetailsUpdate
from dolphin_tracker.domain.models import Page, Stop, StopStatus
from dolphin_tracker.services.stores import StoreQuery, StoreService

router = APIRouter(prefix="/projects/{project_id}/stores", tags=["stores"])
ServiceDep = Annotated[StoreService, Depends(get_store_service)]


def store_query(
    status: Annotated[list[StopStatus] | None, Query()] = None,
    installer: Annotated[list[str] | None, Query(description="Repeatable; empty value = unassigned")] = None,
    q: Annotated[str, Query(max_length=200)] = "",
    sort: Annotated[str, Query(description="store_name, addr, status, installer, day, updated_at, fields.<key>")] = (
        "store_name"
    ),
    dir: Annotated[str, Query(pattern="^(asc|desc)$")] = "asc",
) -> StoreQuery:
    return StoreQuery(status=status or [], installer=installer or [], q=q, sort=sort, dir=dir)


QueryDep = Annotated[StoreQuery, Depends(store_query)]


def _bad_request(exc: ValueError) -> HTTPException:
    return HTTPException(status_code=400, detail=str(exc))


@router.get("", response_model=Page[Stop])
def list_stores(
    project_id: str,
    service: ServiceDep,
    query: QueryDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: str | None = None,
) -> Page[Stop]:
    try:
        return service.list(project_id, query, limit=limit, cursor=cursor)
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.get("/pins", response_model=list[Pin])
def list_pins(project_id: str, service: ServiceDep, query: QueryDep) -> list[dict]:
    try:
        return service.pins(project_id, query)
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.get("/export.csv", response_class=Response, responses={200: {"content": {"text/csv": {}}}})
def export_csv(project_id: str, service: ServiceDep, query: QueryDep) -> Response:
    try:
        body = service.export_csv(project_id, query)
    except ValueError as exc:
        raise _bad_request(exc) from exc
    return Response(
        content=body,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="stores-{project_id}.csv"'},
    )


@router.get("/{stop_uid}", response_model=Stop)
def get_store(project_id: str, stop_uid: str, service: ServiceDep) -> Stop:
    return service.get(project_id, stop_uid)


@router.patch("/{stop_uid}", response_model=Stop)
def update_store(project_id: str, stop_uid: str, body: StoreDetailsUpdate, service: ServiceDep) -> Stop:
    return service.update_details(project_id, stop_uid, body.model_dump(exclude_unset=True))


@router.patch("/{stop_uid}/progress", response_model=Stop)
def update_progress(project_id: str, stop_uid: str, body: ProgressUpdate, service: ServiceDep) -> Stop:
    return service.update_progress(project_id, stop_uid, body.model_dump(exclude_unset=True))
