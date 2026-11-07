from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query

from dolphin_tracker.api.deps import get_route_plan_service, get_store_search_service
from dolphin_tracker.api.schemas import PoolFacets
from dolphin_tracker.domain.models import Page, ScreenStatus
from dolphin_tracker.domain.route_plans import (
    DayInsert,
    DayLockSet,
    InsertOptions,
    InsertQuery,
    MoveToNextDay,
    NextDay,
    PlanPreview,
    PlanResult,
    PlanStatus,
    PlanStoresAdd,
    PoolStore,
    Reassign,
    RoutePlan,
    RoutePlanBundle,
    RoutePlanCreate,
    RoutePlanUpdate,
)
from dolphin_tracker.services.route_plans import RoutePlanService
from dolphin_tracker.services.store_search import PoolQuery, StoreSearchService

router = APIRouter(tags=["route-plans"])
PlanDep = Annotated[RoutePlanService, Depends(get_route_plan_service)]
SearchDep = Annotated[StoreSearchService, Depends(get_store_search_service)]
ListParam = Annotated[list[str] | None, Query(description="Repeatable; a store matches any of the values")]


def pool_query(
    state: ListParam = None,
    city: ListParam = None,
    project_id: ListParam = None,
    status: Annotated[list[ScreenStatus] | None, Query()] = None,
    pending_only: bool = False,
    available_only: bool = False,
    q: Annotated[str, Query(max_length=200)] = "",
) -> PoolQuery:
    return PoolQuery(
        state=state or [], city=city or [], project_id=project_id or [], status=status or [],
        pending_only=pending_only, available_only=available_only, q=q,
    )


PoolDep = Annotated[PoolQuery, Depends(pool_query)]


# ---- the cross-project store picker ----------------------------------------------------------------------------


@router.get("/store-search", response_model=Page[PoolStore])
def search_stores(
    service: SearchDep,
    query: PoolDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: str | None = None,
) -> Page[PoolStore]:
    try:
        return service.search(query, limit=limit, cursor=cursor)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/store-search/pins", response_model=list[PoolStore])
def search_pins(service: SearchDep, query: PoolDep) -> list[PoolStore]:
    """Every match, for the map and "select all" (capped at 5000)."""
    return service.pins(query)


@router.get("/store-search/facets", response_model=PoolFacets)
def search_facets(service: SearchDep, query: PoolDep) -> dict:
    return service.facets(query)


# ---- plans -----------------------------------------------------------------------------------------------------


@router.get("/route-plans", response_model=Page[RoutePlan])
def list_plans(
    service: PlanDep,
    status: PlanStatus = PlanStatus.ACTIVE,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: str | None = None,
) -> Page[RoutePlan]:
    try:
        return service.list(status, limit=limit, cursor=cursor)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/route-plans/preview", response_model=PlanPreview)
def preview_plan(body: RoutePlanCreate, service: PlanDep) -> PlanPreview:
    """The days a plan would get. Nothing is saved or claimed."""
    return service.preview(body)


@router.post("/route-plans", response_model=PlanResult, status_code=201)
def create_plan(body: RoutePlanCreate, service: PlanDep) -> PlanResult:
    return service.create(body)


@router.get("/route-plans/{plan_id}", response_model=RoutePlanBundle)
def get_plan(plan_id: str, service: PlanDep) -> RoutePlanBundle:
    return service.bundle(plan_id)


@router.patch("/route-plans/{plan_id}", response_model=RoutePlanBundle)
def update_plan(plan_id: str, body: RoutePlanUpdate, service: PlanDep) -> RoutePlanBundle:
    return service.update(plan_id, body)


@router.post("/route-plans/{plan_id}/stores", response_model=PlanResult)
def add_stores(plan_id: str, body: PlanStoresAdd, service: PlanDep) -> PlanResult:
    return service.add_stores(plan_id, body)


@router.delete("/route-plans/{plan_id}/stops/{project_id}/{stop_uid}", response_model=RoutePlanBundle)
def remove_stop(plan_id: str, project_id: str, stop_uid: str, service: PlanDep) -> RoutePlanBundle:
    return service.remove_stop(plan_id, project_id, stop_uid)


@router.post("/route-plans/{plan_id}/stops/{project_id}/{stop_uid}/reassign", response_model=RoutePlanBundle)
def reassign_stop(plan_id: str, project_id: str, stop_uid: str, body: Reassign, service: PlanDep) -> RoutePlanBundle:
    return service.reassign(plan_id, project_id, stop_uid, body)


@router.post("/route-plans/{plan_id}/next-day", response_model=RoutePlanBundle)
def next_day(plan_id: str, body: NextDay, service: PlanDep) -> RoutePlanBundle:
    return service.next_day(plan_id, body)


@router.post("/route-plans/{plan_id}/close", response_model=RoutePlanBundle)
def close_plan(plan_id: str, service: PlanDep) -> RoutePlanBundle:
    return service.close(plan_id)


@router.post("/route-plans/{plan_id}/days/lock", response_model=RoutePlanBundle)
def set_day_lock(plan_id: str, body: DayLockSet, service: PlanDep) -> RoutePlanBundle:
    """Lock or unlock one installer's day: recalculations leave a locked day's stores and order alone."""
    return service.set_lock(plan_id, body)


@router.post("/route-plans/{plan_id}/days/insert-options", response_model=InsertOptions)
def day_insert_options(plan_id: str, body: InsertQuery, service: PlanDep) -> InsertOptions:
    """Every place a store can go on a day (between which stores), with the extra driving each costs."""
    return service.insert_options(plan_id, body)


@router.post("/route-plans/{plan_id}/days/insert", response_model=RoutePlanBundle)
def day_insert(plan_id: str, body: DayInsert, service: PlanDep) -> RoutePlanBundle:
    return service.insert(plan_id, body)


@router.post("/route-plans/{plan_id}/stops/{project_id}/{stop_uid}/next-day", response_model=RoutePlanBundle)
def move_stop_to_next_day(
    plan_id: str, project_id: str, stop_uid: str, body: MoveToNextDay, service: PlanDep
) -> RoutePlanBundle:
    return service.move_to_next_day(plan_id, project_id, stop_uid, body)
