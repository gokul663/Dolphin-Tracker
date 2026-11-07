from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from dolphin_tracker.api.deps import SettingsDep, get_places_service
from dolphin_tracker.api.schemas import GeocodeResult, MapsConfig, PlaceHit, StoreFieldSpec, Suggestions
from dolphin_tracker.domain.models import FieldDef
from dolphin_tracker.domain.schema import default_field_schema
from dolphin_tracker.domain.validation import STORE_FIELDS
from dolphin_tracker.services.places import PlacesService

router = APIRouter(tags=["places"])
ServiceDep = Annotated[PlacesService, Depends(get_places_service)]


@router.get("/config/maps", response_model=MapsConfig)
def maps_config(settings: SettingsDep) -> MapsConfig:
    # The browser key is referrer-restricted in Google Cloud; the server key never leaves the backend.
    return MapsConfig(google_maps_browser_key=settings.google_browser_key, google_map_id=settings.google_map_id)


@router.get("/config/field-schema", response_model=list[FieldDef])
def default_schema() -> list[FieldDef]:
    """The schema a new project starts with (§3.1); the import wizard maps sheet columns against it."""
    return default_field_schema()


@router.get("/config/store-fields", response_model=list[StoreFieldSpec])
def store_fields() -> list[StoreFieldSpec]:
    """The store field registry (STORE-MODEL §2–§3) in drawer order, so the UI never keeps its own copy."""
    return [
        StoreFieldSpec(
            name=spec.name, label=spec.label, group=spec.group.value, kind=spec.kind.value, editable=spec.editable,
            required=spec.required, options=list(spec.options),
        )
        for spec in STORE_FIELDS
    ]


@router.get("/places/validate", response_model=GeocodeResult)
def validate_address(
    service: ServiceDep,
    address: Annotated[str, Query(min_length=1, max_length=500)],
    name: Annotated[str, Query(max_length=300, description="The store's name: Google can place the business")] = "",
) -> dict:
    return service.validate(address, name)


@router.get("/places/search", response_model=list[PlaceHit])
def search_places(
    service: ServiceDep,
    address: Annotated[str, Query(min_length=1, max_length=500)],
    name: Annotated[str, Query(max_length=300)] = "",
) -> list[dict]:
    """What Google Search lists for a store (its name with the address, then the address alone)."""
    return service.search(address, name)


@router.get("/places/autocomplete", response_model=Suggestions)
def autocomplete(service: ServiceDep, q: Annotated[str, Query(max_length=500)] = "") -> Suggestions:
    return Suggestions(suggestions=service.autocomplete(q))
