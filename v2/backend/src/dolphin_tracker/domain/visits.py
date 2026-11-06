"""Servicing visits (ROUTE-PLANNER §3, §5). One visit = one submitted log entry for one stick. Pure.

A visit only records that someone went there: it never changes a screen's status (an issue can stay unfixed).
"""
from __future__ import annotations

import uuid
from enum import StrEnum
from typing import Any

from pydantic import Field, field_validator

from dolphin_tracker.domain.base import ApiModel
from dolphin_tracker.domain.lists import clean_name
from dolphin_tracker.domain.models import now_iso

DATE_PATTERN = r"^\d{4}-\d{2}-\d{2}$"


class NetworkType(StrEnum):
    WIFI = "WiFi"
    ETHERNET = "Ethernet"
    LTE = "LTE"


def _required(max_length: int = 200) -> Any:
    return Field(min_length=1, max_length=max_length)


class VisitInput(ApiModel):
    """The New Log Entry form as a Dolphin manager submits it. Store, address, PA/FA and contacts are not sent:
    the server snapshots them from the store and project at submission."""

    screen_id: str = Field(min_length=1, max_length=64)
    visit_date: str = Field(pattern=DATE_PATTERN)
    dd_code: str = _required()
    venue_name: str = _required()
    stick_number: str = _required()
    installer: str = _required()
    dolphin_manager: str = _required()
    network_type: NetworkType
    latest_apk: bool
    kiosk_mode: bool
    category: str = _required()
    subcategory: str = _required()
    replaced_with: str = Field(default="", max_length=200)  # required for the "replaced with" subcategories
    comments: str = Field(default="", max_length=5000)
    route_plan_id: str = Field(default="", max_length=64)  # "" → the store's active plan, if any

    @field_validator(
        "dd_code", "venue_name", "stick_number", "installer", "dolphin_manager", "category", "subcategory",
        "replaced_with", mode="before",
    )
    @classmethod
    def _clean(cls, value: object) -> object:
        return clean_name(value) if isinstance(value, str) else value


class Visit(VisitInput):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    project_id: str
    stop_uid: str
    # Snapshots at submission, so the history still reads right after the store changes.
    store_name: str = ""
    addr: str = ""
    pa: str = ""
    fa: str = ""
    owner_name: str = ""
    owner_phone: str = ""
    owner_email: str = ""
    store_contact_name: str = ""
    store_contact_phone: str = ""
    plan_day: int | None = None
    created_at: str = Field(default_factory=now_iso)


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
