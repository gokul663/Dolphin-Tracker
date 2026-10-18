"""Address parsing and identity helpers. Pure functions ported from v1 server.py."""
from __future__ import annotations

import re

from dolphin_tracker.domain.parsing import clean_cell


def parse_us_formatted_address(formatted: str, store_name: str = "") -> dict[str, str]:
    """Split a Google-style 'street, city, ST 12345, USA' string into parts. Empty dict if it does not fit."""
    parts = [part.strip() for part in clean_cell(formatted).split(",") if part.strip()]
    if parts and parts[-1].upper() in {"USA", "UNITED STATES"}:
        parts = parts[:-1]
    if len(parts) < 3:
        return {}

    match = re.search(r"\b([A-Z]{2})\b(?:\s+(\d{5})(?:-\d{4})?)?", parts[-1].upper())
    if not match:
        return {}

    state = match.group(1)
    zip_code = match.group(2) or ""
    city = parts[-2]
    street_parts = parts[:-2]
    store = clean_cell(store_name).lower()
    if len(street_parts) > 1:
        first = street_parts[0].lower()
        if (store and first == store) or not re.search(r"\d", street_parts[0]):
            street_parts = street_parts[1:]
    street = ", ".join(street_parts).strip()
    if not street or not city:
        return {}
    return {"addr": street, "city": city, "state": state, "zip": zip_code}


def apply_parsed_address(stop: dict) -> bool:
    """Repair a stop whose address columns were shifted or blank, using its geocoded string.

    Returns True when the stop was changed.
    """
    parsed = parse_us_formatted_address(stop.get("geocoded", ""), stop.get("store_name", ""))
    if not parsed:
        return False
    current_addr = clean_cell(stop.get("addr", ""))
    current_city = clean_cell(stop.get("city", ""))
    store = clean_cell(stop.get("store_name", ""))
    shifted = bool(current_addr and store and current_addr.lower() == store.lower()) or bool(
        re.search(r"\d", current_city) and "," in current_city
    )
    missing = (
        not current_addr
        or not current_city
        or not clean_cell(stop.get("state", ""))
        or not clean_cell(stop.get("zip", ""))
    )
    if not shifted and not missing:
        return False
    stop.update(parsed)
    return True


def normalized_address_key(stop: dict) -> str:
    parts = []
    for field in ("addr", "city", "state", "zip"):
        value = re.sub(r"[^a-z0-9]+", " ", clean_cell(stop.get(field, "")).lower()).strip()
        if value:
            parts.append(value)
    return "|".join(parts)


def duplicate_key(stop: dict) -> str:
    """Identity used to skip duplicates on append: venue code when present, else the normalised address."""
    venue_code = clean_cell(stop.get("venue_code", "")).lower()
    if venue_code:
        return f"venue|{venue_code}"
    address = normalized_address_key(stop)
    return f"addr|{address}" if address else ""


# Two-letter codes, as the store model stores `state` (STORE-MODEL §2). Includes DC.
US_STATES: dict[str, str] = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado",
    "CT": "Connecticut", "DE": "Delaware", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho",
    "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana",
    "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire",
    "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York", "NC": "North Carolina", "ND": "North Dakota",
    "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island",
    "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont",
    "VA": "Virginia", "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
    "DC": "District of Columbia",
}
STATE_CODES_BY_NAME = {name.lower(): code for code, name in US_STATES.items()}


def state_code(value: object) -> str:
    """"GA", "ga", "Georgia" → "GA". Anything unrecognised is returned trimmed, unchanged."""
    text = clean_cell(value)
    if text.upper() in US_STATES:
        return text.upper()
    return STATE_CODES_BY_NAME.get(" ".join(text.lower().split()), text)
