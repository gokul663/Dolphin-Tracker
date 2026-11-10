from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from dolphin_tracker.api.deps import get_store_service
from dolphin_tracker.api.schemas import (
    AppendResult,
    AppendStops,
    ExternalIdSet,
    Pin,
    ProgressUpdate,
    ScreensUpdate,
    StateCount,
    StoreDetailsUpdate,
    StoreFilterOptions,
)
from dolphin_tracker.domain.models import ScreenStatus, Stop
from dolphin_tracker.services.stores import Bounds, StorePage, StoreQuery, StoreService

router = APIRouter(prefix="/projects/{project_id}/stores", tags=["stores"])
ServiceDep = Annotated[StoreService, Depends(get_store_service)]


ListParam = Annotated[list[str] | None, Query(description="Repeatable; a store matches any of the values")]


def store_query(
    status: Annotated[list[ScreenStatus] | None, Query()] = None,
    installer: Annotated[list[str] | None, Query(description="Repeatable; empty value = unassigned")] = None,
    pa: ListParam = None,
    state: ListParam = None,
    city: ListParam = None,
    dma: ListParam = None,
    venue_type: ListParam = None,
    dd_code: Annotated[list[str] | None, Query(description="Repeatable; any screen's venue id")] = None,
    screen_size: Annotated[list[str] | None, Query(description="Repeatable; any screen's size")] = None,
    route: Annotated[list[str] | None, Query(description='Repeatable; "In route" or "Not in route"')] = None,
    visit: Annotated[list[str] | None, Query(description="Repeatable; Visited, Partly visited, Not visited")] = None,
    q: Annotated[str, Query(max_length=200)] = "",
    needs_attention: Annotated[bool, Query(description="Only stores added without a name or a verified address")] = (
        False
    ),
    sort: Annotated[str, Query(description="a store attribute, status, installer, day, screens, fields.<key>")] = (
        "store_name"
    ),
    dir: Annotated[str, Query(pattern="^(asc|desc)$")] = "asc",
) -> StoreQuery:
    return StoreQuery(
        status=status or [], installer=installer or [], pa=pa or [], state=state or [], city=city or [],
        dma=dma or [], venue_type=venue_type or [], dd_code=dd_code or [], screen_size=screen_size or [],
        route=route or [], visit=visit or [], q=q, sort=sort, dir=dir, needs_attention=needs_attention,
    )


QueryDep = Annotated[StoreQuery, Depends(store_query)]


def _bad_request(exc: ValueError) -> HTTPException:
    return HTTPException(status_code=400, detail=str(exc))


@router.get("", response_model=StorePage)
def list_stores(
    project_id: str,
    service: ServiceDep,
    query: QueryDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: str | None = None,
    offset: Annotated[int | None, Query(ge=0, description="Jump to this row (page × limit)")] = None,
    north: Annotated[float | None, Query(ge=-90, le=90)] = None,
    south: Annotated[float | None, Query(ge=-90, le=90)] = None,
    east: Annotated[float | None, Query(ge=-180, le=180)] = None,
    west: Annotated[float | None, Query(ge=-180, le=180)] = None,
) -> StorePage:
    """A page of stores. Give all four of north/south/east/west to keep only stores inside the map view."""
    edges = (north, south, east, west)
    if any(edge is not None for edge in edges) and None in edges:
        raise HTTPException(status_code=400, detail="Give all of north, south, east and west, or none")
    bounds = Bounds(north, south, east, west) if north is not None else None  # type: ignore[arg-type]
    try:
        return service.list(project_id, query, limit=limit, cursor=cursor, offset=offset, bounds=bounds)
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.get("/pins", response_model=list[Pin])
def list_pins(project_id: str, service: ServiceDep, query: QueryDep) -> list[dict]:
    try:
        return service.pins(project_id, query)
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.get("/filters", response_model=StoreFilterOptions)
def filter_options(project_id: str, service: ServiceDep, query: QueryDep) -> dict:
    """Distinct values per filter, each counted under the other active filters (whole project, like pins)."""
    try:
        return service.filters(project_id, query)
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.get("/by-state", response_model=list[StateCount])
def stores_by_state(
    project_id: str,
    service: ServiceDep,
    query: QueryDep,
    pending: bool = True,
    limit: Annotated[int, Query(ge=1, le=60)] = 10,
    unit: Annotated[str, Query(pattern="^(stores|screens)$")] = "stores",
) -> list[dict]:
    """Top states by store or screen count (pending only by default), under the active filters except State."""
    try:
        return service.by_state(project_id, query, pending=pending, limit=limit, unit=unit)
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.get("/field-usage", response_model=dict[str, int])
def field_usage(project_id: str, service: ServiceDep) -> dict[str, int]:
    """Stores with a value, per extra-field key (whole project, like pins)."""
    return service.field_usage(project_id)


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


@router.post("/append", response_model=AppendResult)
def append_stores(project_id: str, body: AppendStops, service: ServiceDep) -> dict:
    return service.append(project_id, body.stops, body.pa, body.import_mapping)


@router.get("/{stop_uid}", response_model=Stop)
def get_store(project_id: str, stop_uid: str, service: ServiceDep) -> Stop:
    return service.get(project_id, stop_uid)


@router.patch("/{stop_uid}", response_model=Stop)
def update_store(project_id: str, stop_uid: str, body: StoreDetailsUpdate, service: ServiceDep) -> Stop:
    return service.update_details(project_id, stop_uid, body.model_dump(exclude_unset=True))


@router.put("/{stop_uid}/screens", response_model=Stop)
def update_screens(project_id: str, stop_uid: str, body: ScreensUpdate, service: ServiceDep) -> Stop:
    return service.update_screens(project_id, stop_uid, body.screens, updated_by=body.updated_by)


@router.put("/{stop_uid}/external-id", response_model=Stop)
def set_external_id(project_id: str, stop_uid: str, body: ExternalIdSet, service: ServiceDep) -> Stop:
    """The IBC# of a store that has none (added from the Dolphin data); fixed once set."""
    return service.set_external_id(project_id, stop_uid, body.external_id)


@router.patch("/{stop_uid}/progress", response_model=Stop)
def update_progress(project_id: str, stop_uid: str, body: ProgressUpdate, service: ServiceDep) -> Stop:
    return service.update_progress(project_id, stop_uid, body.model_dump(exclude_unset=True))
