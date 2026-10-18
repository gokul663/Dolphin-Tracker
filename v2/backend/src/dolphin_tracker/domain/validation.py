"""The store field registry (STORE-MODEL §2–§3) and its per-field rules. Pure, no I/O.

One entry per first-class store attribute, in drawer order (§3). Validation, the CSV export columns, the import
header map and the reserved schema keys all read from here, so a new field is added in one place.
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

PHONE_RE = re.compile(r"[+()\d\s.\-/x]{7,30}", re.IGNORECASE)  # digits, separators, an "x" extension
EMAIL_RE = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
URL_TOKEN_RE = re.compile(r"https?://\S+", re.IGNORECASE)
INT_RE = re.compile(r"-?\d+")
OUTLET_STATUSES = ("New", "Existing")


class Kind(StrEnum):
    TEXT = "text"
    MULTILINE = "multiline"
    PHONE = "phone"
    EMAIL = "email"
    URL = "url"
    SELECT = "select"
    INT = "int"  # whole number ≥ 0, or unknown (None)
    BOOL = "bool"
    TRISTATE = "tristate"  # True / False / None (unknown)


class Group(StrEnum):
    IDENTITY = "Identity & address"
    CONTACTS = "Contacts"
    INSTALLATION = "Installation"
    SITE_NOTES = "Site notes"
    SITE_CHECKLIST = "Site checklist"
    SCREENS = "Screens"


@dataclass(frozen=True)
class StoreField:
    name: str
    label: str
    group: Group
    kind: Kind = Kind.TEXT
    editable: bool = True  # in the planner (PATCH …/stores/{uid})
    required: bool = False
    options: tuple[str, ...] = ()


STORE_FIELDS: tuple[StoreField, ...] = (
    # 1. Identity & address. external_id and pa are set on import only; addr/city/state/zip are geocoded on save.
    StoreField("external_id", "IBC#", Group.IDENTITY, editable=False, required=True),
    StoreField("store_name", "Store name", Group.IDENTITY, required=True),
    StoreField("addr", "Address", Group.IDENTITY, required=True),
    StoreField("city", "City", Group.IDENTITY),
    StoreField("state", "State", Group.IDENTITY),
    StoreField("zip", "ZIP", Group.IDENTITY),
    StoreField("pa", "PA", Group.IDENTITY, editable=False),
    StoreField("dma", "DMA", Group.IDENTITY),
    StoreField("venue_type", "Venue type", Group.IDENTITY),
    StoreField("source_date", "Sheet date", Group.IDENTITY, editable=False),
    # 2. Contacts
    StoreField("onsite_contact_name", "On-site contact", Group.CONTACTS),
    StoreField("onsite_contact_phone", "On-site contact phone", Group.CONTACTS, Kind.PHONE),
    StoreField("owner_name", "Store owner", Group.CONTACTS),
    StoreField("owner_phone", "Store owner phone", Group.CONTACTS, Kind.PHONE),
    StoreField("owner_email", "Store owner email", Group.CONTACTS, Kind.EMAIL),
    StoreField("best_contact_time", "Best contact time", Group.CONTACTS),
    StoreField("preferred_language", "Preferred language", Group.CONTACTS),
    # 3. Installation
    StoreField("products_to_avoid", "Products / content to avoid", Group.INSTALLATION, Kind.MULTILINE),
    StoreField("store_ssid", "Store SSID", Group.INSTALLATION),
    StoreField("store_ssid_password", "Store SSID password", Group.INSTALLATION),
    StoreField("installation_notes", "Installation comments", Group.INSTALLATION, Kind.MULTILINE),
    StoreField("image_url", "Pictures (image URL)", Group.INSTALLATION, Kind.URL),
    StoreField("cms_details_added", "CMS details added", Group.INSTALLATION, Kind.BOOL),
    StoreField("outlet_status", "Outlet status", Group.INSTALLATION, Kind.SELECT, options=OUTLET_STATUSES),
    # 4. Site notes (the sheet's comments group)
    StoreField("preferred_area", "Preferred area in store", Group.SITE_NOTES),
    StoreField("ceiling_type", "Ceiling type", Group.SITE_NOTES),
    StoreField("ceiling_height", "Approx. ceiling height", Group.SITE_NOTES),
    StoreField("nearest_power_outlet", "Nearest power outlet", Group.SITE_NOTES),
    StoreField("ethernet_route", "Ethernet cable route", Group.SITE_NOTES),
    StoreField("blocked_dates_notes", "Blocked dates / notes", Group.SITE_NOTES, Kind.MULTILINE),
    StoreField("preferred_install_datetime", "Preferred install date/time", Group.SITE_NOTES),
    # 5. Site checklist
    StoreField("spot_visible", "Spot visible from most of store", Group.SITE_CHECKLIST, Kind.TRISTATE),
    StoreField("power_within_6ft", "Power outlet within 6 ft", Group.SITE_CHECKLIST, Kind.TRISTATE),
    StoreField("ethernet_possible", "Ethernet can be run", Group.SITE_CHECKLIST, Kind.TRISTATE),
    StoreField("low_volume_audio_ok", "Low-volume audio acceptable", Group.SITE_CHECKLIST, Kind.TRISTATE),
    StoreField("ceiling_suitable", "Ceiling suitable for mounting", Group.SITE_CHECKLIST, Kind.TRISTATE),
    # 6. Screens: the committed counts (the actual counts are derived from the screen rows)
    StoreField("committed_dolphin_screens", "Dolphin screens (committed)", Group.SCREENS, Kind.INT),
    StoreField("committed_store_tvs", "Store TVs (committed)", Group.SCREENS, Kind.INT),
)
FIELDS_BY_NAME: dict[str, StoreField] = {field.name: field for field in STORE_FIELDS}
EDITABLE_FIELDS = frozenset(field.name for field in STORE_FIELDS if field.editable)
ADDRESS_FIELDS = frozenset({"addr", "city", "state", "zip"})

_TRUE = frozenset({"yes", "y", "true", "t", "1"})
_FALSE = frozenset({"no", "n", "false", "f", "0"})


def parse_tri_state(value: Any) -> bool | None:
    """Sheet Yes/TRUE → True, No/FALSE → False, anything else (blank, "Unsure", "N/A") → None (unknown)."""
    if isinstance(value, bool):
        return value
    text = "" if value is None else str(value).strip().lower()
    if text in _TRUE:
        return True
    if text in _FALSE:
        return False
    return None


def parse_count(value: Any) -> int | None:
    """The first whole number in a cell ("3", "3.0", "Only 1 Stick" → 1), or None when there is none."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if value.is_integer() else None
    match = INT_RE.search(str(value))
    return int(match.group()) if match else None


def normalize_external_id(value: Any) -> str:
    """IBC# as compared for uniqueness: trimmed, upper case, inner whitespace collapsed to one space."""
    return " ".join(str(value or "").split()).upper()


def _blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def field_error(field: StoreField, value: Any) -> str | None:
    """Why `value` is not acceptable for `field`, or None. Blank is fine unless the field is required."""
    if _blank(value):
        return f"{field.label} is required" if field.required else None
    text = str(value).strip()
    match field.kind:
        case Kind.PHONE:
            digits = sum(char.isdigit() for char in text)
            return None if PHONE_RE.fullmatch(text) and digits >= 7 else f"{field.label}: enter a valid phone number"
        case Kind.EMAIL:
            return None if EMAIL_RE.fullmatch(text) else f"{field.label}: enter a valid email"
        case Kind.URL:
            return None if URL_TOKEN_RE.search(text) else f"{field.label}: needs at least one http(s):// link"
        case Kind.SELECT:
            return None if text in field.options else f"{field.label}: must be one of {', '.join(field.options)}"
        case Kind.INT:
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                return f"{field.label}: must be a whole number of 0 or more"
            return None
        case Kind.BOOL:
            return None if isinstance(value, bool) else f"{field.label}: must be true or false"
        case Kind.TRISTATE:
            return None if isinstance(value, bool) else f"{field.label}: must be yes, no or unknown"
        case _:
            return None


def validate_store_values(values: Mapping[str, Any], *, partial: bool = False) -> dict[str, str]:
    """`{attribute: message}` for every first-class value in `values` that breaks its rule.

    `partial=True` (a PATCH) checks only the keys present; otherwise missing required fields are errors too.
    Keys that are not store fields are ignored here; the caller decides whether they are allowed."""
    errors: dict[str, str] = {}
    for field in STORE_FIELDS:
        if field.name not in values:
            if field.required and not partial:
                errors[field.name] = f"{field.label} is required"
            continue
        message = field_error(field, values[field.name])
        if message:
            errors[field.name] = message
    return errors


DETAIL_ATTRIBUTES = tuple(
    name for name in (field.name for field in STORE_FIELDS) if name not in {"store_name", *ADDRESS_FIELDS}
)


def stop_details(source: Any) -> dict[str, Any]:
    """The first-class detail attributes of a submitted stop, cleaned for storage: text trimmed, the IBC#
    normalised. Name and address are handled by the caller (they are not optional)."""
    details: dict[str, Any] = {}
    for name in DETAIL_ATTRIBUTES:
        value = getattr(source, name)
        details[name] = value.strip() if isinstance(value, str) else value
    details["external_id"] = normalize_external_id(details["external_id"])
    return details
