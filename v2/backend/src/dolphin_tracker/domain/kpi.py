"""Project KPIs, computed on read (AGENT-HANDOFF §4.1, decided in §8). Pure port of v1 `kpi_summary`."""
from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from typing import Any

from pydantic import BaseModel, Field

from dolphin_tracker.domain.parsing import clean_cell

STATUSES = ("Complete", "Incomplete", "Technical Issue", "Other")
KPI_ATTRIBUTES = ("uid", "status", "installer", "installer_name", "fields", "addr", "city", "state", "zip")


class Breakdown(BaseModel):
    total: int = 0
    complete: int = 0
    pending: int = 0


class Kpi(BaseModel):
    total: int = 0
    complete: int = 0
    pending: int = 0
    technical: int = 0
    other: int = 0
    by_status: dict[str, int] = Field(default_factory=lambda: dict.fromkeys(STATUSES, 0))
    by_installer: dict[str, int] = Field(default_factory=dict)
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


def _add(target: dict[str, Breakdown], label: Any, status: str) -> None:
    entry = target.setdefault(clean_cell(label) or "Not provided", Breakdown())
    entry.total += 1
    if status == "Complete":
        entry.complete += 1
    elif status == "Incomplete":
        entry.pending += 1


def kpi_summary(rows: Iterable[Mapping[str, Any]]) -> Kpi:
    """`rows` are stop items or projections with KPI_ATTRIBUTES. Same numbers as v1 for the same data."""
    kpi = Kpi()
    address_groups: dict[str, list[str]] = {}
    for row in rows:
        status = row.get("status") or "Incomplete"
        fields = row.get("fields") or {}
        kpi.total += 1
        kpi.by_status[status] = kpi.by_status.get(status, 0) + 1
        installer = row.get("installer_name") or row.get("installer") or ""
        if installer:
            kpi.by_installer[installer] = kpi.by_installer.get(installer, 0) + 1
        _add(kpi.by_dma, fields.get("dma", ""), status)
        _add(kpi.by_venue_type, fields.get("venue_type", ""), status)
        address_groups.setdefault(_address_key(row), []).append(status)
    kpi.complete = kpi.by_status.get("Complete", 0)
    kpi.pending = kpi.by_status.get("Incomplete", 0)
    kpi.technical = kpi.by_status.get("Technical Issue", 0)
    kpi.other = kpi.by_status.get("Other", 0)
    unique_complete = sum(all(status == "Complete" for status in group) for group in address_groups.values())
    kpi.address_status = Breakdown(
        total=len(address_groups), complete=unique_complete, pending=len(address_groups) - unique_complete
    )
    return kpi
