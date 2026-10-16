"""HTTP request/response models that are not domain records. Domain records live in domain/models.py."""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from dolphin_tracker.domain.models import FieldDef, Project, ProjectType, StopInput, StopStatus


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


class ProjectUpdate(BaseModel):
    """Metadata edit. Installers change only through the installer endpoints; routing state only through jobs."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, max_length=200)
    pa: str | None = Field(default=None, max_length=500)
    project_type: ProjectType | None = None
    field_agent: str | None = Field(default=None, max_length=200)
    partner_account: str | None = Field(default=None, max_length=200)
    pa_percentage: float | None = Field(default=None, ge=0, le=100)
    dolphin_percentage: float | None = Field(default=None, ge=0, le=100)
    store_percentage: float | None = Field(default=None, ge=0, le=100)
    fa_percentage: float | None = Field(default=None, ge=0, le=100)
    stops_per_day: int | None = Field(default=None, ge=1, le=50)
    field_schema: list[FieldDef] | None = None
    expected_version: int | None = Field(default=None, description="409 if the project has moved past this version")


class AppendStops(BaseModel):
    stops: list[StopInput] = Field(min_length=1, max_length=5000)
    pa: str = Field(default="", max_length=500)


class SkippedStop(BaseModel):
    addr: str
    venue_code: str
    reason: str


class AppendResult(BaseModel):
    appended: int
    skipped: list[SkippedStop]
    total: int


class InstallerAdd(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class InstallerRename(BaseModel):
    old_name: str = Field(min_length=1, max_length=200)
    new_name: str = Field(max_length=200)


class StopReassign(BaseModel):
    installer: str = Field(min_length=1, max_length=200)


class ReassignResult(BaseModel):
    old_installer: str
    installer: str
    changed: list[str]  # uids whose installer/day/seq changed
