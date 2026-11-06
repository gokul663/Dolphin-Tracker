from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response

from dolphin_tracker.api.deps import get_list_service
from dolphin_tracker.api.schemas import CategoriesUpdate, NameCreate
from dolphin_tracker.domain.lists import Category, NameEntry, NameListKind
from dolphin_tracker.domain.models import Page
from dolphin_tracker.services.lists import ListService

router = APIRouter(prefix="/lists", tags=["lists"])
ServiceDep = Annotated[ListService, Depends(get_list_service)]


@router.get("/categories", response_model=list[Category])
def list_categories(service: ServiceDep) -> list[Category]:
    """The whole tree (categories → subcategories); the defaults until someone saves a change."""
    return service.categories()


@router.put("/categories", response_model=list[Category])
def replace_categories(body: CategoriesUpdate, service: ServiceDep) -> list[Category]:
    return service.replace_categories(body.categories)


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


@router.delete("/{kind}/{value}", status_code=204, response_class=Response)
def delete_name(kind: NameListKind, value: str, service: ServiceDep) -> Response:
    service.delete_name(kind, value)
    return Response(status_code=204)
