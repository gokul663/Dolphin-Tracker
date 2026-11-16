"""Project KPIs, computed on read (AGENT-HANDOFF §4.1, STORE-MODEL §5). Pure.

Stores count by their derived status; screens count by their own status. Committed screen totals (from the
sheet) sit next to the actual totals derived from the screen rows.
"""
from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from typing import Any

from pydantic import Field

from dolphin_tracker.domain.base import ApiModel
from dolphin_tracker.domain.parsing import clean_cell
from dolphin_tracker.domain.statuses import (
    BUCKET_OF,
    BUCKET_ORDER,
    INSTALLED_STATUSES,
    LEGACY_STATUSES,
    PENDING_STATUSES,
    ScreenStatus,
    StatusBucket,
    VisitState,
    dolphin_screen_size,
    store_assignment,
    visit_state,
)

STATUSES = tuple(status.value for status in ScreenStatus)
FINISHED = frozenset({ScreenStatus.ARCHIVED, ScreenStatus.CANCELLED})
KPI_ATTRIBUTES = (
    "uid", "status", "screens", "installer", "installer_name", "fields", "dma", "venue_type",
    "committed_dolphin_screens", "committed_store_tvs", "addr", "city", "state", "zip", "install_type",
    "screen_visits", "last_planned_at", "needs_attention",
)


def _zeroes() -> dict[str, int]:
    return dict.fromkeys(STATUSES, 0)


def _bucket_zeroes() -> dict[str, int]:
    return dict.fromkeys((bucket.value for bucket in BUCKET_ORDER), 0)


def _visit_zeroes() -> dict[str, int]:
    return dict.fromkeys((state.value for state in VisitState), 0)


class Breakdown(ApiModel):
    total: int = 0
    complete: int = 0
    pending: int = 0


class InstallerProgress(ApiModel):
    """One technician's screens: done = Completed, upcoming = Upcoming or In Progress."""

    done: int = 0
    upcoming: int = 0


class Kpi(ApiModel):
    total: int = 0  # stores
    pending: int = 0  # stores still needing a visit (derived status in the pending set)
    complete: int = 0  # Completed
    offline: int = 0  # Offline: shown on its own, not routed (STORE-MODEL §7 #2)
    other: int = 0  # Archived + Cancelled
    by_status: dict[str, int] = Field(default_factory=_zeroes)  # stores by derived status, all eight
    by_visit: dict[str, int] = Field(default_factory=_visit_zeroes)  # stores by visit state since their latest plan
    needs_attention: int = 0  # stores added without a name or a verified address, not fixed yet
    screens_total: int = 0
    screens_by_status: dict[str, int] = Field(default_factory=_zeroes)
    committed_dolphin_screens: int = 0  # sum of the sheet's committed values
    committed_store_tvs: int = 0
    committed_stores: int = 0  # stores with a committed screen or TV count
    # On the wall (Completed = online, Offline, Needs More Work): the header's "Completed", online and offline together.
    installed_screens: int = 0
    installed_stores: int = 0  # stores with at least one installed screen
    # Installed Dolphin TVs by size ('24"', '43"', '50"'): with installed_screens (one stick each) and the project's
    # prices, the hardware cost.
    installed_dolphin_by_size: dict[str, int] = Field(default_factory=lambda: {'24"': 0, '43"': 0, '50"': 0})
    actual_dolphin_screens: int = 0  # screen rows with is_dolphin_screen
    actual_store_tvs: int = 0  # the other screen rows
    by_installer: dict[str, int] = Field(default_factory=dict)
    by_bucket: dict[str, int] = Field(default_factory=_bucket_zeroes)  # stores by their status's group
    screens_by_bucket: dict[str, int] = Field(default_factory=_bucket_zeroes)
    by_technician: dict[str, InstallerProgress] = Field(default_factory=dict)  # screens, by the sheet's Technician
    install_types: dict[str, int] = Field(default_factory=dict)  # stores by install type ("" = not set)
    by_dma: dict[str, Breakdown] = Field(default_factory=dict)
    by_venue_type: dict[str, Breakdown] = Field(default_factory=dict)
    address_status: Breakdown = Field(default_factory=Breakdown)


def _address_key(row: Mapping[str, Any]) -> str:
    parts = []
    for name in ("addr", "city", "state", "zip"):
        value = re.sub(r"[^a-z0-9]+", " ", clean_cell(row.get(name, "")).lower()).strip()
        if value:
            parts.append(value)
    return "|".join(parts) or f"missing-address|{row.get('uid', '')}"


def _status(value: Any) -> ScreenStatus:
    """A stored status, v2 or v1 (the migration's parity side and items written before v2)."""
    raw = value or ScreenStatus.UPCOMING.value
    try:
        return ScreenStatus(LEGACY_STATUSES.get(raw, raw))
    except ValueError:
        return ScreenStatus.UPCOMING


def _add(target: dict[str, Breakdown], label: Any, status: ScreenStatus) -> None:
    entry = target.setdefault(clean_cell(label) or "Not provided", Breakdown())
    entry.total += 1
    if status == ScreenStatus.COMPLETED:
        entry.complete += 1
    elif status in PENDING_STATUSES:
        entry.pending += 1


def kpi_summary(rows: Iterable[Mapping[str, Any]]) -> Kpi:
    """`rows` are stop items or projections with KPI_ATTRIBUTES (or v1 rows: status + fields only)."""
    kpi = Kpi()
    address_groups: dict[str, list[ScreenStatus]] = {}
    for row in rows:
        status = _status(row.get("status"))
        fields = row.get("fields") or {}
        kpi.total += 1
        if row.get("needs_attention"):
            kpi.needs_attention += 1
        kpi.by_status[status.value] += 1
        kpi.by_bucket[BUCKET_OF[status].value] += 1
        technician, install_type = store_assignment(
            clean_cell(row.get("installer_name") or ""), row.get("install_type") or ""
        )
        kpi.install_types[install_type] = kpi.install_types.get(install_type, 0) + 1
        screens = row.get("screens") or [{"status": status.value, "is_dolphin_screen": True}]
        screen_ids = [screen["id"] for screen in row.get("screens") or [] if screen.get("id")]
        visit = visit_state(screen_ids, row.get("screen_visits") or {}, row.get("last_planned_at") or "")
        kpi.by_visit[visit.value] += 1
        if any(_status(screen.get("status")) in INSTALLED_STATUSES for screen in screens):
            kpi.installed_stores += 1
        if row.get("committed_dolphin_screens") is not None or row.get("committed_store_tvs") is not None:
            kpi.committed_stores += 1
        for screen in screens:
            kpi.screens_total += 1
            if _status(screen.get("status")) in INSTALLED_STATUSES:
                kpi.installed_screens += 1
                if screen.get("is_dolphin_screen", True):
                    size = dolphin_screen_size(str(screen.get("screen_size") or ""))
                    kpi.installed_dolphin_by_size[size] = kpi.installed_dolphin_by_size.get(size, 0) + 1
            screen_status = _status(screen.get("status"))
            kpi.screens_by_status[screen_status.value] += 1
            bucket = BUCKET_OF[screen_status]
            kpi.screens_by_bucket[bucket.value] += 1
            if technician:
                progress = kpi.by_technician.setdefault(technician, InstallerProgress())
                if bucket == StatusBucket.COMPLETED:
                    progress.done += 1
                elif bucket in (StatusBucket.UPCOMING, StatusBucket.IN_PROGRESS):
                    progress.upcoming += 1
            if screen.get("is_dolphin_screen", True):
                kpi.actual_dolphin_screens += 1
            else:
                kpi.actual_store_tvs += 1
        kpi.committed_dolphin_screens += row.get("committed_dolphin_screens") or 0
        kpi.committed_store_tvs += row.get("committed_store_tvs") or 0
        installer = technician or row.get("installer") or ""
        if installer:
            kpi.by_installer[installer] = kpi.by_installer.get(installer, 0) + 1
        # First-class since the store model v2; items and v1 rows written before it carry them in `fields`.
        _add(kpi.by_dma, row.get("dma") or fields.get("dma", ""), status)
        _add(kpi.by_venue_type, row.get("venue_type") or fields.get("venue_type", ""), status)
        address_groups.setdefault(_address_key(row), []).append(status)
    kpi.complete = kpi.by_status[ScreenStatus.COMPLETED.value]
    kpi.pending = sum(kpi.by_status[status.value] for status in PENDING_STATUSES)
    kpi.offline = kpi.by_status[ScreenStatus.OFFLINE.value]
    kpi.other = sum(kpi.by_status[status.value] for status in FINISHED)
    unique_complete = sum(
        all(status == ScreenStatus.COMPLETED for status in group) for group in address_groups.values()
    )
    kpi.address_status = Breakdown(
        total=len(address_groups), complete=unique_complete, pending=len(address_groups) - unique_complete
    )
    return kpi
