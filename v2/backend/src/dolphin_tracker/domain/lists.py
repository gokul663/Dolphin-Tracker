"""Shared pick lists (ROUTE-PLANNER §2, §5): installers, Dolphin managers, visit categories. Pure.

Installers and managers are open lists: a name that is not listed can be typed and is then added. Categories are
the offline portal's nine, each holding the offline-fix reasons as subcategories; the values are kept exactly as
the portal spells them so its history lines up.
"""
from __future__ import annotations

import re
from enum import StrEnum

from pydantic import Field, field_validator

from dolphin_tracker.domain.base import ApiModel


class NameListKind(StrEnum):
    INSTALLERS = "installers"
    MANAGERS = "managers"


class NameEntry(ApiModel):
    value: str = Field(min_length=1, max_length=200)
    created_at: str = ""

    @field_validator("value", mode="before")
    @classmethod
    def _clean(cls, value: object) -> object:
        return clean_name(value) if isinstance(value, str) else value


class Category(ApiModel):
    name: str = Field(min_length=1, max_length=200)
    subcategories: list[str] = Field(default_factory=list, max_length=200)

    @field_validator("subcategories")
    @classmethod
    def _clean(cls, values: list[str]) -> list[str]:
        cleaned = [clean_name(value) for value in values]
        if any(not value for value in cleaned):
            raise ValueError("Subcategories cannot be blank")
        if len({value.lower() for value in cleaned}) != len(cleaned):
            raise ValueError("Subcategories must be unique within a category")
        return cleaned


# Subcategories that need the new stick or screen number recorded (ROUTE-PLANNER §5).
REPLACED_WITH_SUBCATEGORIES = frozenset({"screen replaced with", "Stick Replaced With"})

DEFAULT_CATEGORIES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Network Issues", (
        "Modem need to be replaced", "Store Wifi changed", "Wifi Disconnects itself", "Weak WIFI Connection",
        "Unplugged & WiFi Password issue",
    )),
    ("Power Issues", (
        "screen was unplugged", "Power disconnected", "Power Supply issue", "Wasn't plugged in properly",
        "Usb cord was removed", "Turned off", "TV Off",
    )),
    ("Stick / Device Issues", (
        "Old android box", "Player keep Rebooting", "Screen in recovery mode", "TMV not working", "android crash",
        "Stick Replaced With", "Stick Replace & Shift", "Old Stick Missing", "TMV stick replaced", "stick was loose",
    )),
    ("Display Issues", (
        "Screen display not working", "Screen malfunction", "Screen Error", "No Signal Issue", "HDMI cable faulty",
        "Loose cable connect", "screen replaced with", "Screen & Stick replaced",
    )),
    ("Configuration", ("Home screen", "TMV updated", "TMV & APK updated")),
    ("Store Issues", (
        "Permanently closed", "Temporarily closed", "Store closed", "Renovation process", "Owner Changed",
        "Owner Changed Store", "Dont want screen", "Owner wants the screen", "Payment issue",
    )),
    ("Removal", ("Removed", "Reallocated Screen", "Moved to another location", "Missing Screen")),
    ("Issue Not Resolved (Follow-up Required)", ("screen was not fixed",)),
    ("Other", ("New screen Added",)),
)


def default_categories() -> list[Category]:
    return [Category(name=name, subcategories=list(subs)) for name, subs in DEFAULT_CATEGORIES]


def clean_name(value: str) -> str:
    """Collapse whitespace; names keep their case (the portal's values are case-sensitive labels)."""
    return " ".join(str(value or "").split())


def name_key(value: str) -> str:
    """Case- and space-insensitive identity, so "ann  smith" does not become a second "Ann Smith"."""
    return re.sub(r"\s+", " ", clean_name(value).lower())


def check_categories(categories: list[Category]) -> list[str]:
    """Problems with a full category tree (empty list on success)."""
    errors = []
    if not categories:
        errors.append("At least one category is required")
    names = [name_key(category.name) for category in categories]
    if len(set(names)) != len(names):
        errors.append("Category names must be unique")
    return errors


def find_subcategory(categories: list[Category], category: str, subcategory: str) -> tuple[str, str] | None:
    """The canonical (category, subcategory) spelling for a submitted pair, or None if it is not in the tree."""
    for entry in categories:
        if name_key(entry.name) != name_key(category):
            continue
        for sub in entry.subcategories:
            if name_key(sub) == name_key(subcategory):
                return entry.name, sub
        return None
    return None
