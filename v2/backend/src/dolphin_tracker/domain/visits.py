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
from dolphin_tracker.domain.statuses import VisitState as VisitState  # re-exported
from dolphin_tracker.domain.statuses import visit_state as visit_state

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


