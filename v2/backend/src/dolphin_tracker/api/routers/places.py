from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from dolphin_tracker.api.deps import SettingsDep, get_places_service
from dolphin_tracker.api.schemas import GeocodeResult, MapsConfig, Suggestions
from dolphin_tracker.domain.models import FieldDef
from dolphin_tracker.domain.schema import default_field_schema
from dolphin_tracker.services.places import PlacesService

router = APIRouter(tags=["places"])
ServiceDep = Annotated[PlacesService, Depends(get_places_service)]


@router.get("/config/maps", response_model=MapsConfig)
def maps_config(settings: SettingsDep) -> MapsConfig:
    # The browser key is referrer-restricted in Google Cloud; the server key never leaves the backend.
    return MapsConfig(google_maps_browser_key=settings.google_browser_key)


@router.get("/config/field-schema", response_model=list[FieldDef])
def default_schema() -> list[FieldDef]:
    """The schema a new project starts with (§3.1); the import wizard maps sheet columns against it."""
    return default_field_schema()


@router.get("/places/validate", response_model=GeocodeResult)
def validate_address(service: ServiceDep, address: Annotated[str, Query(min_length=1, max_length=500)]) -> dict:
    return service.validate(address)


@router.get("/places/autocomplete", response_model=Suggestions)
def autocomplete(service: ServiceDep, q: Annotated[str, Query(max_length=500)] = "") -> Suggestions:
    return Suggestions(suggestions=service.autocomplete(q))
