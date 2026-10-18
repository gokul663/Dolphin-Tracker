"""Core records shared by services, repositories and the API. Field details are refined in DETAILED-PLAN.md."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Generic, Self, TypeVar

from pydantic import Field, field_validator, model_validator

from dolphin_tracker.domain.base import ApiModel
from dolphin_tracker.domain.kpi import Kpi
from dolphin_tracker.domain.statuses import (  # re-exported: callers import statuses from models
    LEGACY_STATUSES,
    ScreenStatus,
    derive_store_status,
)
from dolphin_tracker.domain.statuses import (
    PENDING_STATUSES as PENDING_STATUSES,
)
from dolphin_tracker.domain.statuses import (
    STATUS_ALIASES as STATUS_ALIASES,
)
from dolphin_tracker.domain.statuses import (
    STATUS_PRECEDENCE as STATUS_PRECEDENCE,
)
from dolphin_tracker.domain.statuses import (
    normalize_screen_status as normalize_screen_status,
)

T = TypeVar("T")


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


class ProjectType(StrEnum):
    NEW_INSTALLATION = "new_installation"
    OFFLINE = "offline"
    NEW_INSTALLATION_AND_OFFLINE = "new_installation_and_offline"


def _new_id() -> str:
    return uuid.uuid4().hex


class Screen(ApiModel):
    """One screen (stick) at a store (§4.1). Ids are minted by the server and kept when a list is sent back."""

    id: str = Field(default_factory=_new_id)
    stick_number: str = Field(default="", max_length=200)
    venue_id: str = Field(default="", max_length=200)  # the "DD code"
    screen_size: str = Field(default="", max_length=50)
    is_dolphin_screen: bool = True
    has_mount: bool = False
    has_ceiling_mount: bool = False  # False: wall mount, the default
    status: ScreenStatus = ScreenStatus.UPCOMING

    @field_validator("status", mode="before")
    @classmethod
    def _legacy_status(cls, value: Any) -> Any:
        return LEGACY_STATUSES.get(value, value) if isinstance(value, str) else value


class RoutingStatus(StrEnum):
    READY = "ready"
    BUILDING = "building"
    FAILED = "failed"


class JobType(StrEnum):
    IMPORT_PARSE = "import_parse"
    ROUTING_BUILD = "routing_build"


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class FieldType(StrEnum):
    TEXT = "text"
    NUMBER = "number"
    SELECT = "select"
    DATE = "date"
    PHONE = "phone"
    EMAIL = "email"


class FieldDef(ApiModel):
    """One entry of a project's field schema. Store name and address are fixed and not listed here."""

    key: str
    label: str
    type: FieldType = FieldType.TEXT
    required: bool = False
    options: list[str] = Field(default_factory=list)
    source_column: str | None = None


class Project(ApiModel):
    id: str
    name: str
    pa: str = ""
    project_type: ProjectType
    installers: list[str] = Field(default_factory=list)
    field_agent: str = ""
    partner_account: str = ""
    pa_percentage: float | None = None
    dolphin_percentage: float | None = None
    store_percentage: float | None = None
    fa_percentage: float | None = None
    stops_per_day: int = Field(default=8, ge=1, le=50)
    field_schema: list[FieldDef] = Field(default_factory=list)
    # The column → field mapping the last import confirmed, by normalised header (STORE-MODEL §6); the next
    # sheet of the same shape starts from it.
    import_mappings: dict[str, str] = Field(default_factory=dict)
    routing_status: RoutingStatus = RoutingStatus.READY
    routing_job_id: str = ""  # the routing job allowed to finish the current build (§3.2 fence); "" when idle
    stop_count: int = 0  # informational: incremented on create/append, never decremented; KPIs are authoritative
    version: int = 1
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)


class StoreDetails(ApiModel):
    """The first-class store attributes (STORE-MODEL §2) shared by a stored stop and a submitted one.

    Text defaults to "", counts and tri-state checks to None (unknown). Rules per field: `domain/validation.py`.
    """

    external_id: str = Field(default="", max_length=100)  # IBC#; set on import only, unique per project
    pa: str = Field(default="", max_length=500)  # only when the sheet has a PA column; display falls back to project
    dma: str = Field(default="", max_length=200)
    venue_type: str = Field(default="", max_length=200)
    source_date: str = Field(default="", max_length=50)  # the sheet row's Date
    onsite_contact_name: str = Field(default="", max_length=200)
    onsite_contact_phone: str = Field(default="", max_length=50)
    owner_name: str = Field(default="", max_length=200)
    owner_phone: str = Field(default="", max_length=50)
    owner_email: str = Field(default="", max_length=200)
    best_contact_time: str = Field(default="", max_length=200)
    preferred_language: str = Field(default="", max_length=100)
    products_to_avoid: str = Field(default="", max_length=2000)
    store_ssid: str = Field(default="", max_length=200)
    store_ssid_password: str = Field(default="", max_length=200)
    installation_notes: str = Field(default="", max_length=5000)
    image_url: str = Field(default="", max_length=5000)  # raw; may hold several URLs
    cms_details_added: bool = False
    outlet_status: str = Field(default="", max_length=20)  # "", "New" or "Existing"
    committed_dolphin_screens: int | None = Field(default=None, ge=0)
    committed_store_tvs: int | None = Field(default=None, ge=0)
    preferred_area: str = Field(default="", max_length=500)
    ceiling_type: str = Field(default="", max_length=200)
    ceiling_height: str = Field(default="", max_length=100)
    nearest_power_outlet: str = Field(default="", max_length=500)
    ethernet_route: str = Field(default="", max_length=500)
    blocked_dates_notes: str = Field(default="", max_length=2000)
    preferred_install_datetime: str = Field(default="", max_length=500)
    spot_visible: bool | None = None
    power_within_6ft: bool | None = None
    ethernet_possible: bool | None = None
    low_volume_audio_ok: bool | None = None
    ceiling_suitable: bool | None = None


class Stop(StoreDetails):
    """Planning data, store details, screens and field progress for one store, stored as one item.

    `status` is derived from `screens` (§4.2) on every validation; a stop always has at least one screen. Items
    written before v2 (one v1 status, no screens) read as one screen carrying that status."""

    uid: str
    display_id: str = ""
    store_name: str
    addr: str
    city: str = ""
    state: str = ""
    zip: str = ""
    lat: float | None = None
    lng: float | None = None
    geocoded: str = ""
    installer: str = ""
    day: int = 1
    seq: int = 0
    fields: dict[str, Any] = Field(default_factory=dict)
    screens: list[Screen] = Field(default_factory=list)
    status: ScreenStatus = ScreenStatus.UPCOMING
    comment: str = ""
    additional_task: bool = False
    installer_name: str = ""
    route_stale: bool = False  # address/geo changed after the last routing build
    updated_at: str = Field(default_factory=now_iso)
    updated_by: str = ""

    @field_validator("status", mode="before")
    @classmethod
    def _legacy_status(cls, value: Any) -> Any:
        return LEGACY_STATUSES.get(value, value) if isinstance(value, str) else value

    @model_validator(mode="after")
    def _derive_status(self) -> Self:
        if not self.screens:
            self.screens = [Screen(status=self.status)]
        self.status = derive_store_status(self.screens)
        return self


# Disjoint write groups on a stop item (AGENT-HANDOFF §2 rule 5). A single write never mixes ROUTING and PROGRESS.
# Screens carry the per-screen status, so they are progress; `status` is their derived summary.
ROUTING_FIELDS = frozenset({"installer", "day", "seq"})
PROGRESS_FIELDS = frozenset({"screens", "status", "comment", "additional_task", "installer_name", "updated_by"})


class ScreenInput(ApiModel):
    """A screen row as a client sends it: `id` only when it already exists (kept on a screens PUT)."""

    id: str | None = Field(default=None, max_length=64)
    stick_number: str = Field(default="", max_length=200)
    venue_id: str = Field(default="", max_length=200)
    screen_size: str = Field(default="", max_length=50)
    is_dolphin_screen: bool = True
    has_mount: bool = False
    has_ceiling_mount: bool = False
    status: ScreenStatus = ScreenStatus.UPCOMING

    def to_screen(self) -> Screen:
        data = self.model_dump(exclude={"id"})
        return Screen(**data, **({"id": self.id} if self.id else {}))


class StopInput(StoreDetails):
    """One stop as the client submits it on create or append. The server mints uid, display_id, seq and day.

    Without `screens` the stop gets one screen with `initial_status` (or Upcoming)."""

    store_name: str = Field(max_length=300)
    addr: str = Field(max_length=500)
    city: str = Field(default="", max_length=200)
    state: str = Field(default="", max_length=50)
    zip: str = Field(default="", max_length=20)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)
    geocoded: str = Field(default="", max_length=500)
    fields: dict[str, Any] = Field(default_factory=dict)
    screens: list[ScreenInput] = Field(default_factory=list, max_length=200)
    initial_status: ScreenStatus | None = None

    def build_screens(self) -> list[Screen]:
        if self.screens:
            return [screen.to_screen() for screen in self.screens]
        return [Screen(status=self.initial_status or ScreenStatus.UPCOMING)]


class ProjectCreate(ApiModel):
    name: str = Field(max_length=200)
    pa: str = Field(max_length=500)
    project_type: ProjectType
    installers: list[str] = Field(min_length=1, max_length=50)
    field_agent: str = Field(default="", max_length=200)
    partner_account: str = Field(default="", max_length=200)
    pa_percentage: float = Field(ge=0, le=100)
    dolphin_percentage: float = Field(ge=0, le=100)
    store_percentage: float | None = Field(default=None, ge=0, le=100)
    fa_percentage: float | None = Field(default=None, ge=0, le=100)
    stops_per_day: int = Field(default=8, ge=1, le=50)
    field_schema: list[FieldDef] | None = None  # None → DEFAULT_FIELD_SCHEMA
    stops: list[StopInput] = Field(default_factory=list, max_length=5000)
    import_mapping: dict[str, str] = Field(default_factory=dict)  # the import's mapping, saved on the project


class Job(ApiModel):
    id: str
    type: JobType
    status: JobStatus = JobStatus.QUEUED
    project_id: str | None = None
    progress: int = Field(default=0, ge=0, le=100)
    message: str = ""
    payload: dict[str, Any] = Field(default_factory=dict)  # job-specific input (upload key, routing mode, ...)
    result_key: str | None = None
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)


class JobView(Job):
    """A job as the API returns it: plus a short-lived URL for the result once it has succeeded."""

    result_url: str | None = None


class InstallerStats(ApiModel):
    total: int
    pending: int = 0  # stops whose derived status still needs a visit (PENDING_STATUSES)
    days: int
    avg_stops: float
    miles: float


class RoutesBundle(ApiModel):
    """Whole-project payload for the Routes tab: per installer, days in order, stops by seq.

    `installers` is the project's list followed by any installer a stop is routed to that the list lacks."""

    installers: list[str]
    stops_per_day: int
    routing_status: RoutingStatus
    routes: dict[str, list[list[Stop]]]
    stats: dict[str, InstallerStats]


class Page(ApiModel, Generic[T]):
    items: list[T]
    next_cursor: str | None = None


class ProjectSummary(Project):
    """A project as the dashboard lists it: META plus KPIs computed on read."""

    kpi: Kpi
