from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from dolphin_tracker.api.auth import PrincipalDep
from dolphin_tracker.api.deps import get_store_service, get_upload_service
from dolphin_tracker.api.schemas import (
    AppendResult,
    AppendStops,
    ExternalIdSet,
    HardwareCounts,
    Pin,
    ProgressUpdate,
    ScreensUpdate,
    StateCount,
    StoreAdd,
    StoreDetailsUpdate,
    StoreFilterOptions,
    StoreOverview,
    StoreTagSet,
)
from dolphin_tracker.domain.auth import (
    SERVICE_PROGRESS_FIELDS,
    SERVICE_STORE_FIELDS,
    Permission,
    Principal,
    store_edit_problem,
)
from dolphin_tracker.domain.models import ScreenStatus, Stop
from dolphin_tracker.domain.statuses import StatusBucket
from dolphin_tracker.services.stores import (
    COMPARISON_PATTERN,
    Bounds,
    Near,
    ScreenPage,
    StorePage,
    StoreQuery,
    StoreService,
    parse_comparison,
)
from dolphin_tracker.services.uploads import UploadService

router = APIRouter(prefix="/projects/{project_id}/stores", tags=["stores"])
ServiceDep = Annotated[StoreService, Depends(get_store_service)]
UploadDep = Annotated[UploadService, Depends(get_upload_service)]


ListParam = Annotated[list[str] | None, Query(description="Repeatable; a store matches any of the values")]
NumberParam = Annotated[
    str | None,
    Query(pattern=COMPARISON_PATTERN, description='A comparison with a whole number: "gt:2", "lt:3" or "eq:0"'),
]
DayParam = Annotated[str, Query(pattern=r"^(\d{4}-\d{2}-\d{2})?$", description="YYYY-MM-DD, inclusive; empty = open")]


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
    bucket: Annotated[list[StatusBucket] | None, Query(description="Repeatable; the store's status group")] = None,
    install_type: Annotated[list[str] | None, Query(description="Repeatable; Technician, Self install, …")] = None,
    technician: Annotated[list[str] | None, Query(description="Repeatable; a technician's name, \"\" = none")] = None,
    mount: Annotated[list[str] | None, Query(description='Repeatable; "Needs mount" or "No mount needed"')] = None,
    fulfilled: Annotated[
        list[str] | None,
        Query(description='Repeatable; "Fulfilled", "Needs review", "Mismatch ignored", "Not fulfilled", '
                          '"No commitment"'),
    ] = None,
    review: Annotated[
        list[str] | None, Query(description='Repeatable; "Has review notes" or "No review notes"')
    ] = None,
    screens_committed: NumberParam = None,
    screens_installed: NumberParam = None,
    mounts_needed: NumberParam = None,
    mounts_installed: NumberParam = None,
    committed_over_installed: Annotated[
        list[str] | None, Query(description='Repeatable; "Yes" (fewer screens installed than committed) or "No"')
    ] = None,
    tag: Annotated[list[str] | None, Query(description='Repeatable; one of the project\'s tags, "" = no tag')] = None,
    first_registered_from: DayParam = "",
    first_registered_to: DayParam = "",
    last_registered_from: DayParam = "",
    last_registered_to: DayParam = "",
    near_lat: Annotated[
        float | None, Query(ge=-90, le=90, description="Nearby: with near_lng and radius_miles")
    ] = None,
    near_lng: Annotated[float | None, Query(ge=-180, le=180)] = None,
    radius_miles: Annotated[float | None, Query(gt=0, le=3000)] = None,
    q: Annotated[str, Query(max_length=200)] = "",
    needs_attention: Annotated[bool, Query(description="Only stores added without a name or a verified address")] = (
        False
    ),
    sort: Annotated[
        str,
        Query(description="a store attribute, status, installer, day, screens, tag, fields.<key>; distance (Nearby)"),
    ] = (
        "store_name"
    ),
    dir: Annotated[str, Query(pattern="^(asc|desc)$")] = "asc",
) -> StoreQuery:
    nearby = (near_lat, near_lng, radius_miles)
    if any(part is not None for part in nearby) and None in nearby:
        raise HTTPException(status_code=400, detail="Give all of near_lat, near_lng and radius_miles, or none")
    near = Near(near_lat, near_lng, radius_miles) if near_lat is not None else None  # type: ignore[arg-type]
    return StoreQuery(
        status=status or [], installer=installer or [], pa=pa or [], state=state or [], city=city or [],
        dma=dma or [], venue_type=venue_type or [], dd_code=dd_code or [], screen_size=screen_size or [],
        route=route or [], visit=visit or [], bucket=bucket or [], install_type=install_type or [],
        technician=technician or [], mount=mount or [], fulfilled=fulfilled or [], review=review or [],
        screens_committed=parse_comparison(screens_committed), screens_installed=parse_comparison(screens_installed),
        mounts_needed=parse_comparison(mounts_needed), mounts_installed=parse_comparison(mounts_installed),
        committed_over_installed=committed_over_installed or [], tag=tag or [],
        first_registered_from=first_registered_from, first_registered_to=first_registered_to,
        last_registered_from=last_registered_from, last_registered_to=last_registered_to, near=near,
        q=q, sort=sort, dir=dir,
        needs_attention=needs_attention,
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


@router.get("/screens", response_model=ScreenPage)
def list_screens(
    project_id: str,
    service: ServiceDep,
    query: QueryDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    north: Annotated[float | None, Query(ge=-90, le=90)] = None,
    south: Annotated[float | None, Query(ge=-90, le=90)] = None,
    east: Annotated[float | None, Query(ge=-180, le=180)] = None,
    west: Annotated[float | None, Query(ge=-180, le=180)] = None,
) -> ScreenPage:
    """A page of screens, one row each, under the same filters as the stores. `sort` also takes venue_id, status
    (the screen's), screen_size, owner and brand."""
    edges = (north, south, east, west)
    if any(edge is not None for edge in edges) and None in edges:
        raise HTTPException(status_code=400, detail="Give all of north, south, east and west, or none")
    bounds = Bounds(north, south, east, west) if north is not None else None  # type: ignore[arg-type]
    try:
        return service.screens(project_id, query, limit=limit, offset=offset, bounds=bounds)
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.get("/overview", response_model=StoreOverview)
def stores_overview(
    project_id: str,
    service: ServiceDep,
    query: QueryDep,
    pending: bool = True,
    limit: Annotated[int, Query(ge=1, le=60)] = 10,
    unit: Annotated[str, Query(pattern="^(stores|screens)$")] = "stores",
) -> dict:
    """The map pins, the filter options, the top states (`pending`, `limit`, `unit` as for /by-state) and the
    hardware counts under the same filters, from one read of the project's stores."""
    try:
        return service.overview(project_id, query, pending=pending, limit=limit, unit=unit)
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


@router.get("/hardware", response_model=HardwareCounts)
def stores_hardware(project_id: str, service: ServiceDep, query: QueryDep) -> dict:
    """Installed hardware (sticks, Dolphin TVs by size) of the stores the filters keep: every filter applies."""
    try:
        return service.hardware(project_id, query)
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
def append_stores(project_id: str, body: AppendStops, service: ServiceDep, uploads: UploadDep) -> dict:
    result = service.append(project_id, body.stops, body.pa, body.import_mapping)
    uploads.record(project_id, body.import_job_id, kind="append", submitted=len(body.stops),
                   added=result["appended"], skipped=len(result["skipped"]))
    return result


@router.post("", response_model=Stop, status_code=201)
def add_store(project_id: str, body: StoreAdd, service: ServiceDep) -> Stop:
    """Add one store by hand, with the checks a sheet row gets (422 names what is wrong)."""
    return service.add_one(project_id, body.model_dump())


@router.get("/{stop_uid}", response_model=Stop)
def get_store(project_id: str, stop_uid: str, service: ServiceDep) -> Stop:
    return service.get(project_id, stop_uid)


@router.delete("/{stop_uid}", status_code=204, response_class=Response)
def delete_store(project_id: str, stop_uid: str, service: ServiceDep) -> Response:
    """Admins only. Deletes the store with its screens and visits; 409 while it is in a route plan."""
    service.delete(project_id, stop_uid)
    return Response(status_code=204)


def _may_edit(
    who: Principal, service: StoreService, project_id: str, stop_uid: str, fields: set[str],
    allowed: frozenset[str] | None,
) -> None:
    """Someone who edits projects may; someone who only logs visits may while the store is on a route, and then
    only the fields a visit touches."""
    if who.can(Permission.PROJECTS_EDIT):
        return
    on_route = bool(service.get(project_id, stop_uid).route_plan_id)
    problem = store_edit_problem(who, on_route, fields, allowed)
    if problem:
        raise HTTPException(status_code=403, detail=problem)


@router.patch("/{stop_uid}", response_model=Stop)
def update_store(
    project_id: str, stop_uid: str, body: StoreDetailsUpdate, service: ServiceDep, who: PrincipalDep
) -> Stop:
    changes = body.model_dump(exclude_unset=True)
    _may_edit(who, service, project_id, stop_uid, set(changes), SERVICE_STORE_FIELDS)
    return service.update_details(project_id, stop_uid, changes)


@router.put("/{stop_uid}/screens", response_model=Stop)
def update_screens(project_id: str, stop_uid: str, body: ScreensUpdate, service: ServiceDep, who: PrincipalDep) -> Stop:
    _may_edit(who, service, project_id, stop_uid, set(), None)
    return service.update_screens(project_id, stop_uid, body.screens, updated_by=body.updated_by)


@router.put("/{stop_uid}/external-id", response_model=Stop)
def set_external_id(project_id: str, stop_uid: str, body: ExternalIdSet, service: ServiceDep) -> Stop:
    """The ExtID of a store that has none (added from the CMS data); fixed once set."""
    return service.set_external_id(project_id, stop_uid, body.external_id)


@router.put("/{stop_uid}/tag", response_model=Stop)
def set_tag(project_id: str, stop_uid: str, body: StoreTagSet, service: ServiceDep) -> Stop:
    """The store's tag: one of the project's tag options, or "" for none."""
    return service.set_tag(project_id, stop_uid, body.tag)


@router.patch("/{stop_uid}/progress", response_model=Stop)
def update_progress(
    project_id: str, stop_uid: str, body: ProgressUpdate, service: ServiceDep, who: PrincipalDep
) -> Stop:
    changes = body.model_dump(exclude_unset=True)
    _may_edit(who, service, project_id, stop_uid, set(changes), SERVICE_PROGRESS_FIELDS)
    return service.update_progress(project_id, stop_uid, changes)
