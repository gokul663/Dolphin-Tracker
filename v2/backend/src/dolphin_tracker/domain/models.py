"""Core records shared by services, repositories and the API. Field details are refined in DETAILED-PLAN.md."""
from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Generic, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


class ProjectType(StrEnum):
    NEW_INSTALLATION = "new_installation"
    OFFLINE = "offline"
    NEW_INSTALLATION_AND_OFFLINE = "new_installation_and_offline"


class StopStatus(StrEnum):
    INCOMPLETE = "Incomplete"  # shown as "Upcoming" in the UI
    COMPLETE = "Complete"
    TECHNICAL_ISSUE = "Technical Issue"
    OTHER = "Other"


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


class FieldDef(BaseModel):
    """One entry of a project's field schema. Store name and address are fixed and not listed here."""

    key: str
    label: str
    type: FieldType = FieldType.TEXT
    required: bool = False
    options: list[str] = Field(default_factory=list)
    source_column: str | None = None


class Project(BaseModel):
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
    routing_status: RoutingStatus = RoutingStatus.READY
    stop_count: int = 0
    version: int = 1
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)


class Stop(BaseModel):
    """Planning data and field progress for one store, stored as one item."""

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
    status: StopStatus = StopStatus.INCOMPLETE
    comment: str = ""
    additional_task: bool = False
    installer_name: str = ""
    route_stale: bool = False  # address/geo changed after the last routing build
    updated_at: str = Field(default_factory=now_iso)
    updated_by: str = ""


# Disjoint write groups on a stop item (AGENT-HANDOFF §2 rule 5). A single write never mixes ROUTING and PROGRESS.
ROUTING_FIELDS = frozenset({"installer", "day", "seq"})
PROGRESS_FIELDS = frozenset({"status", "comment", "additional_task", "installer_name", "updated_by"})


class Job(BaseModel):
    id: str
    type: JobType
    status: JobStatus = JobStatus.QUEUED
    project_id: str | None = None
    progress: int = Field(default=0, ge=0, le=100)
    message: str = ""
    result_key: str | None = None
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)


class Page(BaseModel, Generic[T]):
    items: list[T]
    next_cursor: str | None = None
