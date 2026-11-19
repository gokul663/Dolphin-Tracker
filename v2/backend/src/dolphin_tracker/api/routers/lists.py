from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response

from dolphin_tracker.api.deps import get_installer_work_service, get_list_service
from dolphin_tracker.api.schemas import CategoriesUpdate, InstallerSave, NameCreate
from dolphin_tracker.domain.lists import Category, NameEntry, NameListKind, clean_name
from dolphin_tracker.domain.models import Page
from dolphin_tracker.services.lists import (
    InstallerSaved,
    InstallerSyncResult,
    InstallerWorkReport,
    InstallerWorkService,
    ListService,
)

router = APIRouter(prefix="/lists", tags=["lists"])
ServiceDep = Annotated[ListService, Depends(get_list_service)]


@router.get("/categories", response_model=list[Category])
def list_categories(service: ServiceDep) -> list[Category]:
    """The whole tree (categories → subcategories); the defaults until someone saves a change."""
    return service.categories()


@router.put("/categories", response_model=list[Category])
def replace_categories(body: CategoriesUpdate, service: ServiceDep) -> list[Category]:
    return service.replace_categories(body.categories)


WorkDep = Annotated[InstallerWorkService, Depends(get_installer_work_service)]


@router.get("/installers/work", response_model=InstallerWorkReport)
def installer_work(service: WorkDep) -> InstallerWorkReport:
    """Per installer, across every project: stores assigned and their screens done and upcoming; and the names on
    stores that match no installer."""
    return service.report()


@router.post("/installers/sync", response_model=InstallerSyncResult)
def sync_installer_names(service: WorkDep) -> InstallerSyncResult:
    """Bring stores whose technician matches an installer (whatever the case) to the Installers list's spelling."""
    return service.sync_names()


@router.get("/{kind}", response_model=Page[NameEntry])
def list_names(
    kind: NameListKind,
    service: ServiceDep,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
    cursor: str | None = None,
) -> Page[NameEntry]:
    return service.names(kind, limit=limit, cursor=cursor)


@router.post("/{kind}", response_model=NameEntry)
def add_name(kind: NameListKind, body: NameCreate, service: ServiceDep) -> NameEntry:
    """Idempotent: a name already in the list (ignoring case and spacing) comes back as stored."""
    return service.add_name(kind, body.value)


@router.put("/installers/{name}", response_model=InstallerSaved)
def save_installer(name: str, body: InstallerSave, service: ServiceDep, work: WorkDep) -> InstallerSaved:
    """Add an installer or change their details. 422 names the field: a name and a phone number are needed, unless
    `allow_no_phone` is sent. `new_name` renames them; the stores and active route plans that name them follow."""
    saved = service.save_installer(name, **body.model_dump())
    stores, plans = work.rename_records(name, saved.value) if saved.value != clean_name(name) else (0, 0)
    return InstallerSaved(**saved.model_dump(), stores_renamed=stores, plans_renamed=plans)


@router.delete("/{kind}/{value}", status_code=204, response_class=Response)
def delete_name(kind: NameListKind, value: str, service: ServiceDep) -> Response:
    service.delete_name(kind, value)
    return Response(status_code=204)
