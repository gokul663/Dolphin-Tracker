"""HTTP request/response models that are not domain records. Domain records live in domain/models.py."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import ConfigDict, Field

from dolphin_tracker.domain.base import ApiModel
from dolphin_tracker.domain.models import FieldDef, Project, ProjectType, ScreenStatus, StopInput


class MapsConfig(ApiModel):
    google_maps_browser_key: str
    google_map_id: str = ""  # Google Cloud Map ID (vector map, advanced markers); "" uses the default raster map


class GeocodeResult(ApiModel):
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


class Suggestions(ApiModel):
    suggestions: list[str]


class ImportJobCreate(ApiModel):
    filename: str = Field(min_length=1, max_length=255)
    content_type: str = Field(default="application/octet-stream", max_length=255)
    project_id: str | None = None  # set when appending to an existing project


class ImportJobCreated(ApiModel):
    job_id: str
    upload_url: str  # presigned S3 PUT, or /api/jobs/{job_id}/upload in local mode
    upload_key: str


class ProjectCreated(ApiModel):
    project: Project
    job_id: str | None = None  # the routing job; absent when the project has no stops (201)


class JobAccepted(ApiModel):
    job_id: str


class Pin(ApiModel):
    uid: str
    lat: float
    lng: float
    status: ScreenStatus
    store_name: str
    installer: str
    day: int


class StoreDetailsUpdate(ApiModel):
    """Detail edit. Omitted keys are unchanged; `fields` merges per key into the stop's custom fields."""

    store_name: str | None = Field(default=None, max_length=300)
    addr: str | None = Field(default=None, max_length=500)
    city: str | None = Field(default=None, max_length=200)
    state: str | None = Field(default=None, max_length=50)
    zip: str | None = Field(default=None, max_length=20)
    fields: dict[str, Any] | None = None


class ProgressUpdate(ApiModel):
    status: ScreenStatus | None = None  # sets every screen of the stop to this status
    comment: str | None = Field(default=None, max_length=2000)
    additional_task: bool | None = None
    installer_name: str | None = Field(default=None, max_length=200)
    updated_by: str | None = Field(default=None, max_length=200)


class ProjectUpdate(ApiModel):
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


class AppendStops(ApiModel):
    stops: list[StopInput] = Field(min_length=1, max_length=5000)
    pa: str = Field(default="", max_length=500)


class SkippedStop(ApiModel):
    addr: str
    venue_code: str
    reason: str


class AppendResult(ApiModel):
    appended: int
    skipped: list[SkippedStop]
    total: int


class InstallerAdd(ApiModel):
    name: str = Field(min_length=1, max_length=200)


class InstallerRename(ApiModel):
    old_name: str = Field(min_length=1, max_length=200)
    new_name: str = Field(max_length=200)


class StopReassign(ApiModel):
    installer: str = Field(min_length=1, max_length=200)


class ReassignResult(ApiModel):
    old_installer: str
    installer: str
    changed: list[str]  # uids whose installer/day/seq changed


class HealthResponse(ApiModel):
    status: Literal["ok"]
    env: str
    db: bool
    ts: str


class ImportSummary(ApiModel):
    total: int
    valid: int
    needs_review: int
    invalid: int


class ImportRow(ApiModel):
    """One verified spreadsheet row (AGENT-HANDOFF §3.4)."""

    index: int
    address: str  # as uploaded
    store_name: str
    pa: str
    status: Literal["valid", "needs_review", "invalid"]
    confidence: int
    verified_by: list[str]
    formatted: str
    addr: str
    city: str
    state: str
    zip: str
    lat: float | None
    lng: float | None
    place_name: str
    suggestions: list[str]
    error: str
    venue_status: ScreenStatus
    venue_status_valid: bool
    venue_status_raw: str
    fields: dict[str, str]  # keyed by normalised header; mapped to the schema in the review UI


class ImportResult(ApiModel):
    columns: list[str]
    address_column: str
    store_column: str | None
    extra_columns: list[str]
    summary: ImportSummary
    pa_names: list[str]
    rows: list[ImportRow]
