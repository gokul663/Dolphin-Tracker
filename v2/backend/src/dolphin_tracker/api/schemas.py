"""HTTP request/response models that are not domain records. Domain records live in domain/models.py."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import ConfigDict, Field

from dolphin_tracker.domain.base import ApiModel
from dolphin_tracker.domain.lists import Category
from dolphin_tracker.domain.models import FieldDef, Project, ProjectType, ScreenInput, ScreenStatus, StopInput


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


class SkippedStop(ApiModel):
    """A submitted stop that was not written because it repeats another (STORE-MODEL §1.4)."""

    index: int  # position in the submitted list
    external_id: str
    store_name: str
    addr: str
    reason: Literal["external_id", "address"]


class ProjectCreated(ApiModel):
    project: Project
    job_id: str | None = None  # the routing job; absent when the project has no stops (201)
    skipped: list[SkippedStop] = Field(default_factory=list)  # duplicates by IBC#, then address


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
    """Detail edit (STORE-MODEL §2, "editable in planner"). Omitted keys are unchanged; `fields` merges per key
    into the stop's extra fields. Anything else (IBC#, PA, routing, progress, screens) is a 422."""

    model_config = ConfigDict(extra="forbid")

    store_name: str | None = Field(default=None, max_length=300)
    addr: str | None = Field(default=None, max_length=500)
    city: str | None = Field(default=None, max_length=200)
    state: str | None = Field(default=None, max_length=50)
    zip: str | None = Field(default=None, max_length=20)
    dma: str | None = Field(default=None, max_length=200)
    venue_type: str | None = Field(default=None, max_length=200)
    onsite_contact_name: str | None = Field(default=None, max_length=200)
    onsite_contact_phone: str | None = Field(default=None, max_length=50)
    owner_name: str | None = Field(default=None, max_length=200)
    owner_phone: str | None = Field(default=None, max_length=50)
    owner_email: str | None = Field(default=None, max_length=200)
    best_contact_time: str | None = Field(default=None, max_length=200)
    preferred_language: str | None = Field(default=None, max_length=100)
    products_to_avoid: str | None = Field(default=None, max_length=2000)
    store_ssid: str | None = Field(default=None, max_length=200)
    store_ssid_password: str | None = Field(default=None, max_length=200)
    installation_notes: str | None = Field(default=None, max_length=5000)
    image_url: str | None = Field(default=None, max_length=5000)
    cms_details_added: bool | None = None
    outlet_status: str | None = Field(default=None, max_length=20)
    committed_dolphin_screens: int | None = Field(default=None, ge=0)  # null clears it (unknown)
    committed_store_tvs: int | None = Field(default=None, ge=0)
    preferred_area: str | None = Field(default=None, max_length=500)
    ceiling_type: str | None = Field(default=None, max_length=200)
    ceiling_height: str | None = Field(default=None, max_length=100)
    nearest_power_outlet: str | None = Field(default=None, max_length=500)
    ethernet_route: str | None = Field(default=None, max_length=500)
    blocked_dates_notes: str | None = Field(default=None, max_length=2000)
    preferred_install_datetime: str | None = Field(default=None, max_length=500)
    spot_visible: bool | None = None  # tri-state: null = unknown
    power_within_6ft: bool | None = None
    ethernet_possible: bool | None = None
    low_volume_audio_ok: bool | None = None
    ceiling_suitable: bool | None = None
    fields: dict[str, Any] | None = None


class ScreensUpdate(ApiModel):
    """The full list of a store's screen rows (PUT replaces it). Send `id` back to keep a row's identity."""

    model_config = ConfigDict(extra="forbid")

    screens: list[ScreenInput] = Field(min_length=1, max_length=200)
    updated_by: str = Field(default="", max_length=200)


class ProgressUpdate(ApiModel):
    """Field progress other than status (status is per screen: PUT …/screens)."""

    model_config = ConfigDict(extra="forbid")

    comment: str | None = Field(default=None, max_length=2000)
    additional_task: bool | None = None
    installer_name: str | None = Field(default=None, max_length=200)
    updated_by: str | None = Field(default=None, max_length=200)


class FilterOption(ApiModel):
    value: str  # "" = unassigned (installer only)
    count: int  # stores with this value, under the other active filters


class StoreFilterOptions(ApiModel):
    """Per filter, the values present (STORE-MODEL §5). An empty list: no store has a value; grey it out."""

    status: list[FilterOption]
    installer: list[FilterOption]
    pa: list[FilterOption]
    state: list[FilterOption]
    city: list[FilterOption]
    dma: list[FilterOption]
    venue_type: list[FilterOption]
    dd_code: list[FilterOption]
    screen_size: list[FilterOption]


class StoreFieldSpec(ApiModel):
    """One first-class store attribute as the drawer shows it (`domain/validation.STORE_FIELDS`, §3 order)."""

    name: str
    label: str
    group: Literal[
        "WiFi", "Identity & address", "Contacts", "Installation", "Site notes", "Site checklist", "Screens", "Pictures"
    ]
    kind: Literal["text", "multiline", "phone", "email", "url", "select", "int", "bool", "tristate"]
    editable: bool
    required: bool
    options: list[str]


class StateCount(ApiModel):
    state: str
    count: int


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
    import_mapping: dict[str, str] = Field(default_factory=dict)  # merged into project.import_mappings


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
    duplicates: int = 0  # rows repeating an earlier row of the sheet (by IBC#, then address)


class ImportScreen(ApiModel):
    stick_number: str
    venue_id: str
    status: ScreenStatus


class ImportRow(ApiModel):
    """One verified spreadsheet row (AGENT-HANDOFF §3.4)."""

    index: int
    address: str  # as uploaded
    store_name: str
    external_id: str = ""  # IBC#, normalised
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
    coordinates_source: Literal["", "geocode", "sheet"] = ""  # "sheet": geocoding failed, the sheet's lat/lng kept
    place_name: str
    suggestions: list[str]
    error: str
    venue_status: ScreenStatus  # the sheet's status (STATUS, else Shipment / Device status)
    venue_status_valid: bool
    venue_status_raw: str
    installer_name: str = ""  # the sheet's Technician
    details: dict[str, Any] = Field(default_factory=dict)  # first-class store attributes the sheet has (§2)
    screens: list[ImportScreen] = Field(default_factory=list)
    problems: dict[str, str] = Field(default_factory=dict)  # attribute → why the sheet value needs fixing
    duplicate_of: int | None = None  # index of the earlier row this one repeats
    duplicate_reason: Literal["", "external_id", "address"] = ""
    fields: dict[str, str]  # unrecognised columns ("Other imported data"), keyed by normalised header


class ImportMapping(ApiModel):
    """A re-pointed column mapping for a finished import: every sheet column → field ("" other data, "-" ignore)."""

    mapping: dict[str, str]


class ImportResult(ApiModel):
    columns: list[str]
    mapping: dict[str, str] = Field(default_factory=dict)  # column → field ("" other data, "-" ignored)
    address_column: str
    store_column: str | None
    extra_columns: list[str]
    summary: ImportSummary
    pa_names: list[str]
    rows: list[ImportRow]


class NameCreate(ApiModel):
    value: str = Field(min_length=1, max_length=200)


class CategoriesUpdate(ApiModel):
    categories: list[Category] = Field(max_length=100)
