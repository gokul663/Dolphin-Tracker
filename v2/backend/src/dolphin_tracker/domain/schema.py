"""Project field schema: the default entries and validation/coercion of a stop's `fields` map. Pure, no I/O.

Store name and address are fixed core attributes and never appear in a schema.
"""
from __future__ import annotations

import math
import re
from collections.abc import Iterable, Mapping
from datetime import date
from typing import Any

from dolphin_tracker.domain.models import FieldDef, FieldType
from dolphin_tracker.domain.validation import FIELDS_BY_NAME, normalize_external_id, validate_store_values

PHONE_RE = re.compile(r"[+()\d\s.-]{7,20}")
EMAIL_RE = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
KEY_RE = re.compile(r"[a-z][a-z0-9_]{0,63}")
CORE_KEYS = frozenset(
    {
        "uid", "display_id", "store_name", "addr", "city", "state", "zip", "lat", "lng", "geocoded",
        "installer", "day", "seq", "status", "comment", "additional_task", "installer_name", "updated_by",
        "route_stale", "updated_at", "fields",
    }
)

DEFAULT_FIELD_SCHEMA: tuple[FieldDef, ...] = (
    FieldDef(key="pa", label="PA"),
    FieldDef(key="venue_type", label="Venue Type"),
    FieldDef(key="dma", label="DMA"),
    FieldDef(key="venue_code", label="Venue Code"),
    FieldDef(key="owner_name", label="Owner Name"),
    FieldDef(key="owner_phone", label="Owner Phone", type=FieldType.PHONE),
    FieldDef(key="owner_email", label="Owner Email", type=FieldType.EMAIL),
    FieldDef(key="payee_name", label="Payee Name"),
)


def default_field_schema() -> list[FieldDef]:
    """A fresh copy of the default schema, safe to mutate."""
    return [field.model_copy(deep=True) for field in DEFAULT_FIELD_SCHEMA]


def is_blank(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, float) and math.isnan(value):
        return True
    return isinstance(value, str) and not value.strip()


def _as_text(value: Any) -> str:
    return "" if is_blank(value) else str(value).strip()


def _parse_number(value: Any) -> float | int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    try:
        number = float(str(value).strip())
    except ValueError:
        return None
    if not math.isfinite(number):
        return None
    return int(number) if number.is_integer() else number


def _type_error(field: FieldDef, value: Any) -> str | None:
    """Message when a non-blank value does not fit the field type, else None."""
    text = _as_text(value)
    match field.type:
        case FieldType.PHONE:
            return None if PHONE_RE.fullmatch(text) else f"{field.label}: enter a valid phone number"
        case FieldType.EMAIL:
            return None if EMAIL_RE.fullmatch(text) else f"{field.label}: enter a valid email"
        case FieldType.NUMBER:
            return None if _parse_number(value) is not None else f"{field.label}: must be a number"
        case FieldType.SELECT:
            return None if text in field.options else f"{field.label}: must be one of {', '.join(field.options)}"
        case FieldType.DATE:
            try:
                date.fromisoformat(text)
            except ValueError:
                return f"{field.label}: use a YYYY-MM-DD date"
            return None
        case _:
            return None


def validate_fields(
    schema: Iterable[FieldDef], fields: Mapping[str, Any], *, partial: bool = False
) -> list[str]:
    """Every problem with `fields` against `schema`, as human-readable messages. Empty list means valid.

    `partial=True` checks only the keys present in `fields` (a PATCH), so a missing required key is not an
    error but an explicitly blanked one is.
    """
    by_key = {field.key: field for field in schema}
    errors = [f"Unknown field '{key}'" for key in fields if key not in by_key]
    for key, field in by_key.items():
        if partial and key not in fields:
            continue
        value = fields.get(key)
        if is_blank(value):
            if field.required:
                errors.append(f"{field.label} is required")
            continue
        message = _type_error(field, value)
        if message:
            errors.append(message)
    return errors


def coerce_fields(schema: Iterable[FieldDef], fields: Mapping[str, Any]) -> dict[str, Any]:
    """Normalise values for storage: strip text, blanks become "", numbers become int/float.

    Keys outside the schema pass through untouched; `validate_fields` is the gate that rejects them.
    """
    by_key = {field.key: field for field in schema}
    coerced: dict[str, Any] = {}
    for key, value in fields.items():
        field = by_key.get(key)
        if field is None:
            coerced[key] = value
        elif is_blank(value):
            coerced[key] = ""
        elif field.type == FieldType.NUMBER:
            number = _parse_number(value)
            coerced[key] = number if number is not None else _as_text(value)
        else:
            coerced[key] = _as_text(value)
    return coerced


def validate_stop_inputs(schema: Iterable[FieldDef], stops: Iterable[Any]) -> list[dict[str, Any]]:
    """Per-row problems for submitted stops (create, append): the store field rules (IBC#, name and address
    required; phone, email, url, select, counts), then the project's schema fields.

    Returns `[{"index": i, "errors": [...]}]` for the bad rows only.
    """
    schema = list(schema)
    bad = []
    for index, stop in enumerate(stops):
        values = {name: getattr(stop, name) for name in FIELDS_BY_NAME}
        values["external_id"] = normalize_external_id(stop.external_id)
        problems = list(validate_store_values(values).values())  # IBC#, name, address required; field rules
        problems.extend(validate_fields(schema, stop.fields))
        if problems:
            bad.append({"index": index, "errors": problems})
    return bad


def validate_schema(schema: Iterable[FieldDef]) -> list[str]:
    """Problems with a schema definition itself: key format, duplicates, clashes with core attributes."""
    errors: list[str] = []
    seen: set[str] = set()
    for field in schema:
        if not KEY_RE.fullmatch(field.key):
            errors.append(f"Field key '{field.key}' must be lowercase letters, digits or _ and start with a letter")
        elif field.key in CORE_KEYS:
            errors.append(f"Field key '{field.key}' is reserved")
        if field.key in seen:
            errors.append(f"Duplicate field key '{field.key}'")
        seen.add(field.key)
        if not field.label.strip():
            errors.append(f"Field '{field.key}' needs a label")
        if field.type == FieldType.SELECT and not field.options:
            errors.append(f"Select field '{field.key}' needs at least one option")
    return errors
