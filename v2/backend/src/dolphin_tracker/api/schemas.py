"""HTTP request/response models that are not domain records. Domain records live in domain/models.py."""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from dolphin_tracker.domain.models import Project, StopStatus


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


class ProjectCreated(BaseModel):
    project: Project
    job_id: str | None = None  # the routing job; absent when the project has no stops (201)


class JobAccepted(BaseModel):
    job_id: str


class Pin(BaseModel):
    uid: str
    lat: float
    lng: float
    status: StopStatus
    store_name: str
    installer: str
    day: int


class StoreDetailsUpdate(BaseModel):
    """Detail edit. Omitted keys are unchanged; `fields` merges per key into the stop's custom fields."""

    store_name: str | None = Field(default=None, max_length=300)
    addr: str | None = Field(default=None, max_length=500)
    city: str | None = Field(default=None, max_length=200)
    state: str | None = Field(default=None, max_length=50)
    zip: str | None = Field(default=None, max_length=20)
    fields: dict[str, Any] | None = None


class ProgressUpdate(BaseModel):
    status: StopStatus | None = None
    comment: str | None = Field(default=None, max_length=2000)
    additional_task: bool | None = None
    installer_name: str | None = Field(default=None, max_length=200)
    updated_by: str | None = Field(default=None, max_length=200)
