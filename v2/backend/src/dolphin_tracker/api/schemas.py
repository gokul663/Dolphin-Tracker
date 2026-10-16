"""HTTP request/response models that are not domain records. Domain records live in domain/models.py."""
from __future__ import annotations

from pydantic import BaseModel, Field


class MapsConfig(BaseModel):
    google_maps_browser_key: str


class GeocodeResult(BaseModel):
    ok: bool
    status: str | None = None
    formatted: str = ""
    lat: float | None = None
    lng: float | None = None
    addr: str = ""
    city: str = ""
    state: str = ""
    zip: str = ""
    partial: bool = False
    suggestions: list[str] = Field(default_factory=list)
    error: str = ""


class Suggestions(BaseModel):
    suggestions: list[str]
