"""Servicing visits (ROUTE-PLANNER §3, §5). One visit = one submitted log entry for one stick. Pure.

A visit only records that someone went there: it never changes a screen's status (an issue can stay unfixed).
"""
from __future__ import annotations

import uuid
from collections.abc import Iterable
from enum import StrEnum
from typing import Any, Literal

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
    dagent_installed: bool = False  # the third per-stick check (entries before it existed read as "no")
    # Another WiFi this stick is on, when it is not the store's own (which lives on the store).
    wifi_ssid: str = Field(default="", max_length=200)
    wifi_password: str = Field(default="", max_length=200)
    category: str = _required()
    subcategory: str = _required()
    replaced_with: str = Field(default="", max_length=200)  # required for the "replaced with" subcategories
    comments: str = Field(default="", max_length=5000)
    route_plan_id: str = Field(default="", max_length=64)  # "" → the store's active plan, if any
    # What the visit left this screen as, in its plan: "" for an entry logged outside a plan's store window.
    outcome: Literal["", "done", "incomplete"] = ""

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


class StoreCommentInput(ApiModel):
    """A comment on the store as a whole, kept as a log entry of its own (no screen). Saving one also makes it
    the store's `comment` (the latest), which the store window and the CSV read. It is not a visit: no screen
    counts as visited and no plan outcome changes."""

    text: str = Field(min_length=1, max_length=2000)
    visit_date: str = Field(pattern=DATE_PATTERN)
    # Who was there, as the store window's "This visit" row has them; either may be blank.
    installer: str = Field(default="", max_length=200)
    dolphin_manager: str = Field(default="", max_length=200)
    route_plan_id: str = Field(default="", max_length=64)  # "" → the store's active plan, if any

    @field_validator("text", mode="before")
    @classmethod
    def _strip(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("installer", "dolphin_manager", mode="before")
    @classmethod
    def _clean(cls, value: object) -> object:
        return clean_name(value) if isinstance(value, str) else value


class StoreComment(StoreCommentInput):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    project_id: str
    stop_uid: str
    created_by: str = ""  # the signed-in person who saved it (named when the row above was left blank)
    plan_name: str = ""  # snapshot, so the entry still says where it came from after the plan is renamed
    plan_day: int | None = None
    created_at: str = Field(default_factory=now_iso)


def store_outcome(screen_ids: Iterable[str], visits: Iterable[Visit], plan_id: str) -> str:
    """What a store's screens add up to in a plan, from each screen's latest log entry there (`visits` newest
    first): "incomplete" when any screen was left incomplete, "done" when every screen is done, else "" (some
    screen has no outcome yet, so the stop stays as it is)."""
    latest: dict[str, str] = {}
    for visit in visits:
        if visit.route_plan_id == plan_id and visit.outcome:
            latest.setdefault(visit.screen_id, visit.outcome)
    outcomes = [latest.get(screen_id, "") for screen_id in screen_ids]
    if "incomplete" in outcomes:
        return "incomplete"
    return "done" if outcomes and all(outcome == "done" for outcome in outcomes) else ""
