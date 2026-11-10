"""Device report sync (CMS data from MongoDB, read through the device-data Lambda). HTTP only; rules live in
services/device_sync.py."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from dolphin_tracker.api.deps import get_device_sync_service
from dolphin_tracker.api.schemas import DeviceOverwrite, ReviewAdd
from dolphin_tracker.domain.device import ReviewItem
from dolphin_tracker.domain.models import Stop
from dolphin_tracker.services.device_sync import (
    DeviceSyncService,
    OverwriteResult,
    PaList,
    ReviewPage,
    SyncResult,
)

router = APIRouter(tags=["device-sync"])
ServiceDep = Annotated[DeviceSyncService, Depends(get_device_sync_service)]


@router.get("/device-data/pas", response_model=PaList)
def list_device_pas(service: ServiceDep) -> PaList:
    """The PA names in the device report's newest day (Settings' "Sync with PA" list)."""
    return service.list_pas()


@router.post("/projects/{project_id}/device-sync", response_model=SyncResult)
def sync_project(
    project_id: str,
    service: ServiceDep,
    only_if_stale: Annotated[bool, Query(description="Skip when the project already has the newest day")] = False,
) -> SyncResult:
    return service.sync(project_id, only_if_stale=only_if_stale)


@router.get("/projects/{project_id}/device-sync/review", response_model=ReviewPage)
def list_review(
    project_id: str,
    service: ServiceDep,
    include_snoozed: bool = False,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: str | None = None,
) -> ReviewPage:
    """Report records whose DD code is in no store of the project ("Needs review")."""
    return service.review(project_id, include_snoozed=include_snoozed, limit=limit, cursor=cursor)


@router.post("/projects/{project_id}/device-sync/review/{key}/add", response_model=Stop, status_code=201)
def add_reviewed(project_id: str, key: str, service: ServiceDep, body: ReviewAdd | None = None) -> Stop:
    """422 with Google's `suggestions` when the address cannot be verified (send `address`, `place` or
    `add_anyway`), like an imported row."""
    body = body or ReviewAdd()
    return service.add_from_review(
        project_id, key, address=body.address, place=body.place.model_dump() if body.place else None,
        add_anyway=body.add_anyway,
    )


@router.post("/projects/{project_id}/device-sync/review/{key}/snooze", response_model=ReviewItem)
def snooze_reviewed(project_id: str, key: str, service: ServiceDep) -> ReviewItem:
    """"Not now": hidden until the next report day."""
    return service.snooze(project_id, key)


@router.post("/projects/{project_id}/device-sync/overwrite", response_model=OverwriteResult)
def overwrite_all(project_id: str, body: DeviceOverwrite, service: ServiceDep) -> OverwriteResult:
    """Copy the report's values into every synced store's own fields."""
    return service.overwrite(project_id, body.fields)


@router.post("/projects/{project_id}/stores/{stop_uid}/device-overwrite", response_model=OverwriteResult)
def overwrite_store(project_id: str, stop_uid: str, body: DeviceOverwrite, service: ServiceDep) -> OverwriteResult:
    return service.overwrite(project_id, body.fields, stop_uid)


@router.post("/projects/{project_id}/stores/{stop_uid}/device-alert/ignore", response_model=Stop)
def ignore_device_alert(project_id: str, stop_uid: str, service: ServiceDep) -> Stop:
    """Hide "not in Dolphin data" until the next report day."""
    return service.ignore_alert(project_id, stop_uid)
