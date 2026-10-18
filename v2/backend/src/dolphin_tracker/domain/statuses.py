"""Screen statuses (STORE-MODEL §4): the enum, derivation precedence, the pending set and sheet aliases. Pure.

Its own module so `kpi.py` can use it without importing `models.py` (which imports `kpi.py`)."""
from __future__ import annotations

from collections.abc import Iterable
from enum import StrEnum
from typing import Any


class ScreenStatus(StrEnum):
    """Per-screen status (STORE-MODEL §4.2). A store's status is derived from its screens."""

    UPCOMING = "Upcoming"
    INVITATION_EMAIL_SENT = "Invitation Email Sent"
    SHIPPED = "Shipped"
    DELIVERED = "Delivered"
    COMPLETED = "Completed"
    OFFLINE = "Offline"
    ARCHIVED = "Archived"
    CANCELLED = "Cancelled"


# Least-progressed first: the store takes the first status any of its screens has (§4.2).
STATUS_PRECEDENCE: tuple[ScreenStatus, ...] = (
    ScreenStatus.UPCOMING,
    ScreenStatus.INVITATION_EMAIL_SENT,
    ScreenStatus.SHIPPED,
    ScreenStatus.DELIVERED,
    ScreenStatus.OFFLINE,
    ScreenStatus.COMPLETED,
    ScreenStatus.ARCHIVED,
    ScreenStatus.CANCELLED,
)
# Still needs a technician visit, so it is routed. Offline is not (STORE-MODEL §7 #2).
PENDING_STATUSES = frozenset(
    {ScreenStatus.UPCOMING, ScreenStatus.INVITATION_EMAIL_SENT, ScreenStatus.SHIPPED, ScreenStatus.DELIVERED}
)

# Sheet values, case-insensitive after trim (§4.3). Blank is Upcoming.
STATUS_ALIASES: dict[str, ScreenStatus] = {
    **dict.fromkeys(("completed", "complete", "installed", "done"), ScreenStatus.COMPLETED),
    **dict.fromkeys(("technician", "upcoming", "incomplete", "pending", "scheduled", ""), ScreenStatus.UPCOMING),
    **dict.fromkeys(("invitation email sent", "invited", "invitation sent"), ScreenStatus.INVITATION_EMAIL_SENT),
    "shipped": ScreenStatus.SHIPPED,
    "delivered": ScreenStatus.DELIVERED,
    "offline": ScreenStatus.OFFLINE,
    "archived": ScreenStatus.ARCHIVED,
    **dict.fromkeys(("cancelled", "canceled"), ScreenStatus.CANCELLED),
}

# v1's four values (§4.4). Only the migration and items written before v2 carry them.
LEGACY_STATUSES: dict[str, ScreenStatus] = {
    "Incomplete": ScreenStatus.UPCOMING,
    "Complete": ScreenStatus.COMPLETED,
    "Technical Issue": ScreenStatus.OFFLINE,
    "Other": ScreenStatus.UPCOMING,
}


def normalize_screen_status(value: object) -> tuple[ScreenStatus, bool]:
    """A sheet cell → (status, recognised). Unknown values are Upcoming and flagged (`False`) for review."""
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
