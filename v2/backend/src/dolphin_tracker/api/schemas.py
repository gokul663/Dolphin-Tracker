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


class ImportJobCreate(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    content_type: str = Field(default="application/octet-stream", max_length=255)
    project_id: str | None = None  # set when appending to an existing project


class ImportJobCreated(BaseModel):
    job_id: str
    upload_url: str  # presigned S3 PUT, or /api/jobs/{job_id}/upload in local mode
    upload_key: str
