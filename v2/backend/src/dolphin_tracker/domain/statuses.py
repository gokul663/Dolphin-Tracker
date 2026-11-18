"""Screen statuses (STORE-MODEL §4): the enum, derivation precedence, the pending set and sheet aliases. Pure.

Its own module so `kpi.py` can use it without importing `models.py` (which imports `kpi.py`)."""
from __future__ import annotations

import re
from collections.abc import Iterable
from enum import StrEnum
from typing import Any


class ScreenStatus(StrEnum):
    """Per-screen status (STORE-MODEL §4.2). A store's status is derived from its screens."""

    UPCOMING = "Upcoming"
    INVITATION_EMAIL_SENT = "Invitation Email Sent"
    SHIPPED = "Shipped"
    DELIVERED = "Delivered"
    # Visited, but the stick still needs work. Set by hand: a visit never changes status (ROUTE-PLANNER §6).
    NEEDS_MORE_WORK = "Serviced - Needs More Work"
    COMPLETED = "Completed"
    OFFLINE = "Offline"
    # The CMS has the device (a DD code) but it never registered: no first or latest registered date. Set by the
    # device sync; not routed and not counted as installed, like nothing is on the wall yet.
    NOT_REGISTERED = "Not Registered"
    ARCHIVED = "Archived"  # ran for a while (it has a registered date), then was archived
    CANCELLED = "Cancelled"  # never registered a screen: the location was dropped


# Least-progressed first: the store takes the first status any of its screens has (§4.2).
STATUS_PRECEDENCE: tuple[ScreenStatus, ...] = (
    ScreenStatus.UPCOMING,
    ScreenStatus.INVITATION_EMAIL_SENT,
    ScreenStatus.SHIPPED,
    ScreenStatus.DELIVERED,
    ScreenStatus.NEEDS_MORE_WORK,
    ScreenStatus.NOT_REGISTERED,
    ScreenStatus.OFFLINE,
    ScreenStatus.COMPLETED,
    ScreenStatus.ARCHIVED,
    ScreenStatus.CANCELLED,
)
# Still needs a technician visit, so it is routed. Offline is not (STORE-MODEL §7 #2).
PENDING_STATUSES = frozenset(
    {
        ScreenStatus.UPCOMING,
        ScreenStatus.INVITATION_EMAIL_SENT,
        ScreenStatus.SHIPPED,
        ScreenStatus.DELIVERED,
        ScreenStatus.NEEDS_MORE_WORK,
    }
)

# Sheet values, case-insensitive after trim (§4.3). Blank is Upcoming.
STATUS_ALIASES: dict[str, ScreenStatus] = {
    **dict.fromkeys(("completed", "complete", "installed", "done"), ScreenStatus.COMPLETED),
    **dict.fromkeys(("technician", "upcoming", "incomplete", "pending", "scheduled", ""), ScreenStatus.UPCOMING),
    **dict.fromkeys(("invitation email sent", "invited", "invitation sent"), ScreenStatus.INVITATION_EMAIL_SENT),
    "shipped": ScreenStatus.SHIPPED,
    "delivered": ScreenStatus.DELIVERED,
    **dict.fromkeys(
        ("needs more work", "serviced - needs more work", "serviced. needs more work", "serviced needs more work",
         "serviced – needs more work"),
        ScreenStatus.NEEDS_MORE_WORK,
    ),
    "offline": ScreenStatus.OFFLINE,
    "archived": ScreenStatus.ARCHIVED,
    **dict.fromkeys(("not registered", "unregistered", "not-registered"), ScreenStatus.NOT_REGISTERED),
    **dict.fromkeys(
        ("cancelled", "canceled", "cancelled location", "canceled location"), ScreenStatus.CANCELLED
    ),
}



class StatusBucket(StrEnum):
    """The groups the UI shows (KPI bubbles, filter chips, map colours). Stored statuses keep all nine.

    Not Registered is a screen's group only. A store is never "not registered": one whose least-progressed screen
    is Not Registered reads In Progress (STORE_BUCKET_OF), a group only stores have. The in-between work statuses
    (Invitation Email Sent, Shipped, Delivered, Serviced - Needs More Work) still count as Upcoming."""

    COMPLETED = "Completed"
    UPCOMING = "Upcoming"
    IN_PROGRESS = "In Progress"
    OFFLINE = "Offline"
    NOT_REGISTERED = "Not Registered"
    CANCELLED = "Cancelled"
    ARCHIVED = "Archived"


BUCKET_OF: dict[ScreenStatus, StatusBucket] = {
    ScreenStatus.UPCOMING: StatusBucket.UPCOMING,
    ScreenStatus.INVITATION_EMAIL_SENT: StatusBucket.UPCOMING,
    ScreenStatus.SHIPPED: StatusBucket.UPCOMING,
    ScreenStatus.DELIVERED: StatusBucket.UPCOMING,
    ScreenStatus.NEEDS_MORE_WORK: StatusBucket.UPCOMING,
    ScreenStatus.COMPLETED: StatusBucket.COMPLETED,
    ScreenStatus.OFFLINE: StatusBucket.OFFLINE,
    ScreenStatus.NOT_REGISTERED: StatusBucket.NOT_REGISTERED,
    ScreenStatus.ARCHIVED: StatusBucket.ARCHIVED,
    ScreenStatus.CANCELLED: StatusBucket.CANCELLED,
}
BUCKET_ORDER: tuple[StatusBucket, ...] = (
    StatusBucket.COMPLETED,
    StatusBucket.UPCOMING,
    StatusBucket.OFFLINE,
    StatusBucket.NOT_REGISTERED,
    StatusBucket.CANCELLED,
    StatusBucket.ARCHIVED,
)


# Stores: the same groups, with In Progress where screens have Not Registered.
STORE_BUCKET_OF: dict[ScreenStatus, StatusBucket] = {
    **BUCKET_OF, ScreenStatus.NOT_REGISTERED: StatusBucket.IN_PROGRESS,
}
STORE_BUCKET_ORDER: tuple[StatusBucket, ...] = tuple(
    StatusBucket.IN_PROGRESS if bucket == StatusBucket.NOT_REGISTERED else bucket for bucket in BUCKET_ORDER
)


def bucket_of(status: object) -> StatusBucket:
    """A screen's group."""
    return BUCKET_OF[ScreenStatus(status)]


def store_bucket_of(status: object) -> StatusBucket:
    """A store's group, from its derived status."""
    return STORE_BUCKET_OF[ScreenStatus(status)]


class InstallType(StrEnum):
    TECHNICIAN = "Technician"
    SELF_INSTALL = "Self install"
    REP_INSTALL = "Rep install"


INSTALL_TYPES = tuple(item.value for item in InstallType)
# Sheet status values that say nothing about who installs (completed, archived, cancelled location, offline and
# their spellings). Any other non-blank value except "technician" marks a self install.
_NO_INSTALL_TYPE = frozenset(
    {ScreenStatus.COMPLETED, ScreenStatus.ARCHIVED, ScreenStatus.CANCELLED, ScreenStatus.OFFLINE,
     ScreenStatus.NOT_REGISTERED}
)


def install_type_from_sheet(value: object) -> str:
    """The sheet's status cell → install type: "technician" → Technician, the work statuses (completed, archived,
    cancelled location, offline) and blank → "" (unknown), anything else → Self install."""
    raw = "" if value is None else " ".join(str(value).split()).lower()
    if raw == "technician":
        return InstallType.TECHNICIAN.value
    if not raw or STATUS_ALIASES.get(raw) in _NO_INSTALL_TYPE:
        return ""
    return InstallType.SELF_INSTALL.value


# What the sheet's Technician column holds besides names: an install type, or "not known". None of them is a person.
_TECHNICIAN_INSTALL_TYPES = {
    "self install": InstallType.SELF_INSTALL.value, "self-install": InstallType.SELF_INSTALL.value,
    "self": InstallType.SELF_INSTALL.value, "rep install": InstallType.REP_INSTALL.value,
    "rep-install": InstallType.REP_INSTALL.value, "rep": InstallType.REP_INSTALL.value,
}
_NOT_A_TECHNICIAN = frozenset({"unsure", "unknown", "other", "n/a", "na", "none", "tbd", "-", "?"})


# On the wall: done, on the wall but not reporting, or visited and still needing work. Counts as installed against
# the committed screens and TVs.
INSTALLED_STATUSES = frozenset({ScreenStatus.COMPLETED, ScreenStatus.OFFLINE, ScreenStatus.NEEDS_MORE_WORK})


def store_assignment(installer_name: str, install_type: str) -> tuple[str, str]:
    """(technician, install type) for a store. The Technician column's "self install" / "REP install" are install
    types and "unsure" / "OTHER" mean nobody, so none of them is kept as a name. A named technician implies a
    Technician install when no type is set; a self or rep install has no technician."""
    name = " ".join(installer_name.split())
    key = name.lower()
    if key in _TECHNICIAN_INSTALL_TYPES:
        return "", install_type or _TECHNICIAN_INSTALL_TYPES[key]
    if key in _NOT_A_TECHNICIAN:
        return "", install_type
    if install_type in (InstallType.SELF_INSTALL.value, InstallType.REP_INSTALL.value):
        return "", install_type  # the store or a rep installs: no technician is sent
    if name and not install_type:
        return name, InstallType.TECHNICIAN.value
    return name, install_type

# v1's four values (§4.4). Only the migration and items written before v2 carry them.
LEGACY_STATUSES: dict[str, ScreenStatus] = {
    "Incomplete": ScreenStatus.UPCOMING,
    "Complete": ScreenStatus.COMPLETED,
    "Technical Issue": ScreenStatus.OFFLINE,
    "Other": ScreenStatus.UPCOMING,
}


def normalize_screen_status(value: object) -> tuple[ScreenStatus, bool]:
    """A sheet cell → (status, recognised). Unknown values are Upcoming and reported as not recognised; the import
    reads them as a self install (`install_type_from_sheet`) rather than flagging the row."""
    raw = "" if value is None else " ".join(str(value).split()).lower()
    if raw in STATUS_ALIASES:
        return STATUS_ALIASES[raw], True
    exact = {status.value.lower(): status for status in ScreenStatus}
    if raw in exact:
        return exact[raw], True
    return ScreenStatus.UPCOMING, False


def derive_store_status(screens: Iterable[Any]) -> ScreenStatus:
    """The least-progressed screen's status by STATUS_PRECEDENCE; a store without screens is Upcoming.

    `screens` holds Screen models (anything with `.status`), statuses, or their string values."""
    present = {ScreenStatus(getattr(item, "status", item)) for item in screens}
    return next((status for status in STATUS_PRECEDENCE if status in present), ScreenStatus.UPCOMING)


class VisitState(StrEnum):
    """The Projects view overlay (ROUTE-PLANNER §6), from the store's per-stick visit times."""

    NONE = "none"
    PARTLY = "partly"
    VISITED = "visited"


def visit_state(screen_ids: list[str], screen_visits: dict[str, str], since: str = "") -> VisitState:
    """Visited when every stick has a visit at or after `since` (the store's latest plan; "" = ever)."""
    if not screen_ids:
        return VisitState.NONE
    counted = sum(1 for screen_id in screen_ids if screen_visits.get(screen_id) and screen_visits[screen_id] >= since)
    if counted == 0:
        return VisitState.NONE
    return VisitState.VISITED if counted == len(screen_ids) else VisitState.PARTLY


DOLPHIN_SCREEN_SIZE = '24"'  # a Dolphin screen with no size given


def screen_size_label(value: object) -> str:
    """A size as the prices and counts key it: "43", "43in", '43"' → '43"'; "" when it holds no inches."""
    match = re.match(r"\s*(\d{2,3})(?!\d)", str(value or ""))
    return f'{int(match.group(1))}"' if match else ""


def dolphin_screen_size(value: str) -> str:
    """A Dolphin screen's size in inches ("43", "43in", '43"' → '43"'); one without a size is the 24-inch one. Which
    sizes and models Dolphin owns, and what they cost, is the project's price list (Settings)."""
    return screen_size_label(value) or DOLPHIN_SCREEN_SIZE


def dolphin_model_key(size: object, screen_type: object = "") -> str:
    """How installed Dolphin screens are counted and priced: size, then the model when one is chosen ('24"|Dell')."""
    return f"{dolphin_screen_size(str(size or ''))}|{' '.join(str(screen_type or '').split())}"
