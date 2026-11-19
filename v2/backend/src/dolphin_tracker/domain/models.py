"""Core records shared by services, repositories and the API. Field details are refined in DETAILED-PLAN.md."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Generic, Self, TypeVar

from pydantic import ConfigDict, Field, computed_field, field_validator, model_validator

from dolphin_tracker.domain.addresses import parse_us_formatted_address, state_code
from dolphin_tracker.domain.base import ApiModel
from dolphin_tracker.domain.device import DeviceSyncState, ScreenDevice, StoreDevice, split_codes, venue_code_key
from dolphin_tracker.domain.kpi import Kpi
from dolphin_tracker.domain.statuses import (  # re-exported: callers import statuses from models
    LEGACY_STATUSES,
    ScreenStatus,
    derive_store_status,
    dolphin_screen_size,
    screen_size_label,
    store_assignment,
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
    is_dolphin_screen: bool = True  # owned by Dolphin (False: the store's own TV)
    # Its brand: for a Dolphin-owned screen the model from the project's price list ("Dolphin", "Dell"...), for a
    # store's own TV its make ("LG", "TCL"...); "" = not chosen.
    screen_type: str = Field(default="", max_length=100)
    # The screen's name in the CMS and what kind of venue the CMS files it under. The device sync writes both from
    # the report whenever it has a value (the CMS is the main source); a person may fill them before that.
    cms_name: str = Field(default="", max_length=300)
    venue_type: str = Field(default="", max_length=200)
    has_mount: bool = False
    has_ceiling_mount: bool = False  # False: wall mount, the default
    needs_mount: bool = False  # a mount still has to be brought and fitted (independent of has_mount)
    status: ScreenStatus = ScreenStatus.UPCOMING
    # When `status` last changed (a person or the device sync); "" = unknown (set by a sheet or before this
    # existed). A screen Completed after the device report's day is not expected in that report yet.
    status_changed_at: str = ""
    device: ScreenDevice | None = None  # the device report's latest day, when this screen's DD code is in it

    @field_validator("status", mode="before")
    @classmethod
    def _legacy_status(cls, value: Any) -> Any:
        return LEGACY_STATUSES.get(value, value) if isinstance(value, str) else value

    @model_validator(mode="after")
    def _dolphin_screen_size(self) -> Self:
        if self.is_dolphin_screen:
            self.screen_size = dolphin_screen_size(self.screen_size)
        return self




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


class ScreenPrice(ApiModel):
    """One Dolphin-owned screen model and what it costs: a size ('24"') and a type ("Dolphin", "Dell")."""

    size: str = Field(max_length=10)
    type: str = Field(default="", max_length=100)
    cost: float | None = Field(default=None, ge=0)
    # The size's default: what a Dolphin screen of this size is when no type is chosen. One per size.
    is_default: bool = False

    @model_validator(mode="after")
    def _clean(self) -> Self:
        self.size = screen_size_label(self.size)
        self.type = " ".join(self.type.split())
        if not self.size:
            raise ValueError("A screen price needs a size in inches")
        return self


class MountPrice(ApiModel):
    """What the mounts for one screen size cost: the wall mount and the ceiling mount (None = we have none for this
    size, or it is not priced yet)."""

    size: str = Field(max_length=10)
    wall: float | None = Field(default=None, ge=0)
    ceiling: float | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _clean(self) -> Self:
        self.size = screen_size_label(self.size)
        if not self.size:
            raise ValueError("A mount price needs a size in inches")
        return self


class HardwareCosts(ApiModel):
    """What the hardware costs Dolphin, per project (dollars; None = not set). Every installed screen has a stick; a
    Dolphin screen also costs the screen itself, by its size: the types of a size (`screens`, the list the store
    window offers when a Dolphin screen's size is picked) all carry that size's one cost."""

    stick: float | None = Field(default=None, ge=0)
    screens: list[ScreenPrice] = Field(default_factory=list, max_length=100)
    # Mounts, by the screen size they hold: counted in the hardware cost only when asked for.
    mounts: list[MountPrice] = Field(default_factory=list, max_length=50)

    @model_validator(mode="before")
    @classmethod
    def _from_size_prices(cls, value: Any) -> Any:
        """Prices saved before the list existed (one per size: screen_24, screen_43, screen_50) become list rows."""
        if not isinstance(value, dict) or value.get("screens"):
            return value
        old = [(size, value.get(f"screen_{size}")) for size in (24, 43, 50)]
        rows = [{"size": f'{size}"', "type": "Dolphin", "cost": cost} for size, cost in old if cost is not None]
        return {**value, "screens": rows} if rows else value

    @model_validator(mode="after")
    def _one_row_per_model(self) -> Self:
        keys = [(row.size, row.type.lower()) for row in self.screens]
        if len(set(keys)) != len(keys):
            raise ValueError("The same screen size and type is priced twice")
        if len({row.size for row in self.mounts}) != len(self.mounts):
            raise ValueError("The mounts of the same screen size are priced twice")
        # Exactly one default per size: the one marked (the first of several), else the size's first row.
        for size in dict.fromkeys(row.size for row in self.screens):
            rows = [row for row in self.screens if row.size == size]
            chosen = next((row for row in rows if row.is_default), rows[0])
            # A size has one cost, whatever the type: the default's, else the first one set.
            cost = chosen.cost if chosen.cost is not None else next((r.cost for r in rows if r.cost is not None), None)
            for row in rows:
                row.is_default = row is chosen
                row.cost = cost
        return self


class ProjectUpload(ApiModel):
    """One sheet uploaded into the project (on create or append), kept for good: the file itself is in the file
    store under `key`."""

    id: str  # the import job that read it
    filename: str
    key: str
    uploaded_at: str = Field(default_factory=now_iso)
    kind: str = "append"  # "create" (the project's first sheet) or "append"
    size: int = 0  # bytes
    submitted: int = 0  # stores sent from the sheet's review
    added: int = 0
    skipped: int = 0  # duplicates of stores already there (same IBC# or address)


class Project(ApiModel):
    id: str
    name: str
    pa: str = ""
    device_pa: str = ""  # the PA name in the device report this project syncs with; "" = no sync
    device_sync: DeviceSyncState | None = None
    project_type: ProjectType
    installers: list[str] = Field(default_factory=list)
    field_agent: str = ""
    partner_account: str = ""
    pa_percentage: float | None = None
    dolphin_percentage: float | None = None
    store_percentage: float | None = None
    fa_percentage: float | None = None
    hardware_costs: HardwareCosts = Field(default_factory=HardwareCosts)
    stops_per_day: int = Field(default=8, ge=1, le=50)
    field_schema: list[FieldDef] = Field(default_factory=list)
    # The column → field mapping the last import confirmed, by normalised header (STORE-MODEL §6); the next
    # sheet of the same shape starts from it.
    import_mappings: dict[str, str] = Field(default_factory=dict)
    uploads: list[ProjectUpload] = Field(default_factory=list)  # every sheet imported, newest last
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
    install_type: str = Field(default="", max_length=20)  # "", "Technician", "Self install" or "Rep install"
    committed_dolphin_screens: int | None = Field(default=None, ge=0)
    committed_store_tvs: int | None = Field(default=None, ge=0)
    # Mounts to bring, typed over the number worked out from the Upcoming screens (None = not typed: the worked-out
    # number stands). The 24 inch wall mount is its own piece; `wall_mounts_needed` is every other size.
    wall_mounts_needed: int | None = Field(default=None, ge=0)
    wall_24_mounts_needed: int | None = Field(default=None, ge=0)
    # Hardware used at the store, typed over what its screens add up to (None = the worked-out number).
    screens_used: int | None = Field(default=None, ge=0)
    mounts_used: int | None = Field(default=None, ge=0)
    ceiling_mounts_needed: int | None = Field(default=None, ge=0)
    tv_mounts_needed: int | None = Field(default=None, ge=0)
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


class NeedsAttention(StrEnum):
    STORE_NAME = "store_name"
    ADDRESS = "address"
    # Added from the Dolphin data without an IBC#: entered once in the store (then fixed like any IBC#).
    EXTERNAL_ID = "external_id"
    # A Completed screen whose DD code is missing from the device report (set and cleared by the device sync).
    NOT_REPORTING = "not_reporting"
    # A screen's DD code entry holds several codes: not parsed, so it needs a manual fix (device sync sets it).
    DD_CODE_REVIEW = "dd_code_review"


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
    # Added by hand without a store name and/or a verified address ("store_name", "address"). Each reason clears
    # itself once fixed: a name is entered, or the address is verified (or a Google place picked).
    needs_attention: list[NeedsAttention] = Field(default_factory=list)
    device: StoreDevice | None = None  # device-report values shown over the sheet's (Overwrite copies them in)
    device_alert_ignored: str = ""  # report day whose "not in Dolphin data" alert was ignored
    # Route Planner (ROUTE-PLANNER §3, §7): the active plan holding this store ("" = none), and when the store last
    # joined a plan (kept after the plan closes; the "Visited" overlay counts visits from then on).
    route_plan_id: str = ""
    last_planned_at: str = ""
    # Servicing visits: stick (screen id) → when its latest visit was logged, and the latest of those.
    screen_visits: dict[str, str] = Field(default_factory=dict)
    last_visit_at: str = ""
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
        self.screens = merge_same_code(self.screens)
        self.status = derive_store_status(self.screens)
        self.installer_name, self.install_type = store_assignment(self.installer_name, self.install_type)
        return self

    def _place(self) -> tuple[str, str]:
        """(city, state) as lists, filters and charts show them: the Dolphin data's when the store has it, else the
        verified address's (so "texas" typed in the sheet reads TX), else what was typed, the state as its code ("" when
        it is not one).""" 
        verified = parse_us_formatted_address(self.geocoded)
        device = self.device
        city = (device.city if device else "") or verified.get("city") or self.city.strip()
        state = (device.state if device else "") or verified.get("state") or self.state
        code = state_code(state)
        return city, code if len(code) == 2 and code.isalpha() else ""  # "#N/A" and the like are not a state

    @computed_field  # type: ignore[prop-decorator]
    @property
    def place_city(self) -> str:
        return self._place()[0]

    @computed_field  # type: ignore[prop-decorator]
    @property
    def place_state(self) -> str:
        return self._place()[1]


def merge_same_code(screens: list[Screen]) -> list[Screen]:
    """One row per DD code. `DD-H5036X` and `DD_H5036X` are the same screen, so rows that share a code (a sheet row and
    the row the Dolphin data added for it, say) become one, where the first of them stood: each value is the first
    row's when it has one, else the next's (stick #, size); mount flags are kept if any row has them; the status is
    the first that is not Upcoming; the Dolphin data comes from whichever row has it. Rows without a code, or with
    several codes in one entry, are left alone."""
    groups: dict[str, list[Screen]] = {}
    for screen in screens:
        key = venue_code_key(screen.venue_id)
        if key and len(split_codes(screen.venue_id)) == 1:
            groups.setdefault(key, []).append(screen)
    if all(len(group) == 1 for group in groups.values()):
        return screens
    merged: list[Screen] = []
    seen: set[str] = set()
    for screen in screens:
        key = venue_code_key(screen.venue_id)
        group = groups.get(key) if key and len(split_codes(screen.venue_id)) == 1 else None
        if not group or len(group) == 1:
            merged.append(screen)
            continue
        if key in seen:
            continue
        seen.add(key)
        base, rest = group[0], group[1:]
        progressed = next((row for row in group if row.status != ScreenStatus.UPCOMING), base)
        merged.append(base.model_copy(update={
            "stick_number": next((row.stick_number for row in group if row.stick_number.strip()), ""),
            "screen_size": next((row.screen_size for row in group if row.screen_size.strip()), ""),
            "screen_type": next((row.screen_type for row in group if row.screen_type.strip()), ""),
            "cms_name": next((row.cms_name for row in group if row.cms_name.strip()), ""),
            "venue_type": next((row.venue_type for row in group if row.venue_type.strip()), ""),
            "has_mount": any(row.has_mount for row in group),
            "has_ceiling_mount": any(row.has_ceiling_mount for row in group),
            "needs_mount": any(row.needs_mount for row in group),
            "status": progressed.status,
            "status_changed_at": progressed.status_changed_at,
            "device": base.device or next((row.device for row in rest if row.device), None),
        }))
    return merged


# Disjoint write groups on a stop item (AGENT-HANDOFF §2 rule 5). A single write never mixes ROUTING and PROGRESS.
# Screens carry the per-screen status, so they are progress; `status` is their derived summary.
ROUTING_FIELDS = frozenset({"installer", "day", "seq"})
PROGRESS_FIELDS = frozenset({"screens", "status", "comment", "additional_task", "installer_name", "updated_by"})
# Written only by the route-plan and visit paths, never by detail, progress or routing writes.
PLAN_FIELDS = frozenset({"route_plan_id", "last_planned_at"})
VISIT_FIELDS = frozenset({"screen_visits", "last_visit_at"})
# Written only by the device sync: the screens it re-statuses, their summary, the report overlay and the alert.
DEVICE_FIELDS = frozenset(
    {"screens", "status", "device", "needs_attention", "device_alert_ignored", "dma", "venue_type"}
)


class ScreenInput(ApiModel):
    """A screen row as a client sends it: `id` only when it already exists (kept on a screens PUT)."""

    id: str | None = Field(default=None, max_length=64)
    stick_number: str = Field(default="", max_length=200)
    venue_id: str = Field(default="", max_length=200)
    screen_size: str = Field(default="", max_length=50)
    is_dolphin_screen: bool = True
    screen_type: str = Field(default="", max_length=100)
    cms_name: str = Field(default="", max_length=300)
    venue_type: str = Field(default="", max_length=200)
    has_mount: bool = False
    has_ceiling_mount: bool = False
    needs_mount: bool = False
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
    installer_name: str = Field(default="", max_length=200)  # the sheet's Technician ("Completed by")
    # Add the store anyway, without a name and/or a verified address: those checks are skipped and the store is
    # flagged until fixed.
    needs_attention: list[NeedsAttention] = Field(default_factory=list)

    def build_screens(self) -> list[Screen]:
        if self.screens:
            return [screen.to_screen() for screen in self.screens]
        return [Screen(status=self.initial_status or ScreenStatus.UPCOMING)]


class ProjectCreate(ApiModel):
    """A project is stores only: installers and the per-day cap belong to route plans, so they are a 422 here."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(max_length=200)
    pa: str = Field(default="", max_length=500)  # required unless the stops carry their own PA (several PAs)
    project_type: ProjectType
    field_agent: str = Field(default="", max_length=200)
    partner_account: str = Field(default="", max_length=200)
    pa_percentage: float | None = Field(default=None, ge=0, le=100)
    dolphin_percentage: float | None = Field(default=None, ge=0, le=100)
    store_percentage: float | None = Field(default=None, ge=0, le=100)
    fa_percentage: float | None = Field(default=None, ge=0, le=100)
    field_schema: list[FieldDef] | None = None  # None → DEFAULT_FIELD_SCHEMA
    stops: list[StopInput] = Field(default_factory=list, max_length=5000)
    import_mapping: dict[str, str] = Field(default_factory=dict)  # the import's mapping, saved on the project
    import_job_id: str = Field(default="", max_length=64)  # the import job the stops came from: its sheet is kept


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


def attention_of(stop: StopInput) -> list[NeedsAttention]:
    """Why a new store needs attention: no name, or an address added without being verified (no map pin)."""
    reasons = []
    if NeedsAttention.EXTERNAL_ID in stop.needs_attention and not stop.external_id.strip():
        reasons.append(NeedsAttention.EXTERNAL_ID)
    if not stop.store_name.strip():
        reasons.append(NeedsAttention.STORE_NAME)
    if NeedsAttention.ADDRESS in stop.needs_attention or stop.lat is None or stop.lng is None:
        reasons.append(NeedsAttention.ADDRESS)
    if any(len(split_codes(screen.venue_id)) > 1 for screen in stop.screens):
        reasons.append(NeedsAttention.DD_CODE_REVIEW)  # "DD-1. DD-2" in one entry: split it by hand
    return reasons
