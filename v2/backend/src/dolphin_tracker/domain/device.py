"""Device data from the CMS (the Dolphin internal report in MongoDB): one record per venue per day. Pure.

Value shapes only, so `models.py` can hold them without importing the sync rules (`domain/device_sync.py`).
"""
from __future__ import annotations

import re
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any

from pydantic import Field

from dolphin_tracker.domain.base import ApiModel


def venue_type_label(category: object) -> str:
    """The CMS's OOH category as a venue type: its kind of place, without the spot inside it.
    `retail.convenience_store` → "Convenience Store", `retail.gas_stations.shop` → "Gas Stations",
    `retail` → "Retail"."""
    parts = [part for part in str(category or "").strip().lower().split(".") if part]
    if not parts:
        return ""
    kind = parts[1] if len(parts) > 1 else parts[0]
    return " ".join(word.capitalize() for word in kind.split("_") if word)


def venue_code_key(value: object) -> str:
    """A DD code as matched across sources: `DD_ABC123`, `dd-abc123` and ` DD-ABC123 ` are the same venue."""
    return re.sub(r"\s+", "", str(value or "")).upper().replace("-", "_")


# Separators between codes (or stick numbers) in one sheet cell: "DD-HJGK7Z. DD-HB8P6I", "DD-1, DD-2", "DD-1/DD-2",
# one per line. Spaces alone separate only when every piece is code-sized, so "DD - ABC123" stays one code.
_CODE_SEPARATORS = re.compile(r"[,;|/\n]+|\.(?=\s|$)")


def split_codes(value: object) -> list[str]:
    """The DD codes (or stick numbers) in one sheet cell, in order."""
    codes: list[str] = []
    for part in _CODE_SEPARATORS.split(str(value or "")):
        part = part.strip(" .\t")
        if not part:
            continue
        tokens = part.split()
        codes.extend(tokens if len(tokens) > 1 and all(len(token) >= 5 for token in tokens) else [part])
    return codes


def report_date_iso(value: object) -> str:
    """The report's `Date` (MM-DD-YYYY) as YYYY-MM-DD; "" when it is not that shape."""
    match = re.fullmatch(r"(\d{1,2})-(\d{1,2})-(\d{4})", str(value or "").strip())
    if not match:
        return ""
    month, day, year = (int(part) for part in match.groups())
    try:
        return datetime(year, month, day).date().isoformat()
    except ValueError:
        return ""


def utc_iso(value: object) -> str:
    """A Mongo datetime (naive UTC) or an ISO-ish string as an ISO timestamp; "" when unknown."""
    if isinstance(value, datetime):
        moment = value if value.tzinfo else value.replace(tzinfo=UTC)
        return moment.astimezone(UTC).isoformat()
    return str(value).strip() if value not in (None, "") else ""


def _text(value: object) -> str:
    return "" if value is None else " ".join(str(value).split())


def _number(value: object) -> float | None:
    if isinstance(value, bool) or value in (None, ""):
        return None
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


class DeviceRecord(ApiModel):
    """The fields the tracker reads from one report row. Text is "" and numbers None when the CMS has no value."""

    venue_id: str  # as the CMS writes it, e.g. DD_HFN64S
    date: str  # the report day, YYYY-MM-DD
    status: str = ""  # Online, Offline, Archived, Not Registered, Testing, Unclassified
    last_seen: str = ""
    offline_days: int | None = None
    serial_number: str = ""
    venue_name: str = ""  # the CMS name
    store_name: str = ""
    address: str = ""  # the CMS's one-line address
    addr: str = ""  # street part of `address`
    city: str = ""
    state: str = ""
    zip: str = ""
    lat: float | None = None
    lng: float | None = None
    pa_name: str = ""
    external_id: str = ""  # the CMS's "PK External ID" (e.g. an ExtID), when it has one
    dma: str = ""  # the CMS's "DMA" name, e.g. "Atlanta"
    venue_type: str = ""  # the CMS's "OOH Category" as a label: retail.convenience_store → "Convenience Store"
    # When the device first registered with the CMS and when it last did (ISO, UTC). Both "" = it never registered.
    first_registered: str = ""
    last_registered: str = ""

    @property
    def registered(self) -> bool:
        return bool(self.first_registered or self.last_registered)

    @classmethod
    def from_report(cls, doc: dict[str, Any]) -> DeviceRecord:
        """One `dolphin-internal-report` document."""
        address = _text(doc.get("Address"))
        city = _text(doc.get("City"))
        street = address.split(",")[0].strip() if address and "," in address else address
        lat, lng = _number(doc.get("Latitude")), _number(doc.get("Longitude"))
        if lat is not None and lng is not None and not (-90 <= lat <= 90 and -180 <= lng <= 180):
            lat = lng = None
        if lat == 0 and lng == 0:  # "no fix", not the Gulf of Guinea
            lat = lng = None
        offline = _number(doc.get("Offline Days"))
        return cls(
            venue_id=_text(doc.get("Venue ID")),
            date=report_date_iso(doc.get("Date")),
            status=_text(doc.get("Status")),
            last_seen=utc_iso(doc.get("Last Seen (UTC)")),
            offline_days=int(offline) if offline is not None else None,
            serial_number=_text(doc.get("Serial Number")),
            venue_name=_text(doc.get("Venue Name")),
            store_name=_text(doc.get("Store Name")),
            address=address,
            addr=street,
            city=city,
            state=_text(doc.get("State Code")) or _text(doc.get("State")),
            zip=_text(doc.get("Zip Code")),
            lat=lat,
            lng=lng,
            pa_name=_text(doc.get("PA Name")),
            external_id=_text(doc.get("PK External ID")),
            dma=_text(doc.get("DMA")),
            venue_type=venue_type_label(doc.get("OOH Category")),
            first_registered=utc_iso(doc.get("First Registered Time Stamp")),
            last_registered=utc_iso(doc.get("Latest Registered Time Stamp")),
        )


class DeviceSnapshot(ApiModel):
    """One PA's records for the report's latest day."""

    pa: str
    date: str  # YYYY-MM-DD
    ingested_at: str = ""  # when the CMS loaded that day; a status set after this is newer than the report
    records: list[DeviceRecord] = Field(default_factory=list)


class DeviceLog(ApiModel):
    """One servicing log entry from the CMS (`dolphin_venue_vision.logs`): what was found at a device on a day and
    who dealt with it. Read-only here; text is "" when the CMS has no value."""

    id: str = ""
    date: str = ""  # the day of the work, YYYY-MM-DD
    dd_code: str = ""
    venue_name: str = ""
    store_name: str = ""
    address: str = ""
    pa: str = ""
    installer: str = ""
    stick_number: str = ""
    stick_model: str = ""
    dolphin_manager: str = ""
    category: str = ""
    detailed_comments: str = ""
    created_at: str = ""

    @classmethod
    def from_log(cls, doc: dict[str, Any]) -> DeviceLog:
        return cls(**{name: _text(doc.get(name)) for name in cls.model_fields if name != "created_at"},
                   created_at=utc_iso(doc.get("created_at")))


def code_variants(codes: Iterable[object]) -> list[str]:
    """How a DD code may be written in the CMS: `DD_ABC123` (its own spelling) and `DD-ABC123` (the sheets')."""
    keys = sorted({key for code in codes if (key := venue_code_key(code))})
    return [variant for key in keys for variant in dict.fromkeys((key, key.replace("_", "-")))]


class ScreenDevice(ApiModel):
    """What the report said about one screen on its latest day (shown in the "from Dolphin data" colour)."""

    status: str = ""
    last_seen: str = ""
    offline_days: int | None = None
    serial_number: str = ""
    venue_name: str = ""
    date: str = ""
    first_registered: str = ""  # ISO, UTC; both "" = the device never registered
    last_registered: str = ""


class StoreDevice(ApiModel):
    """Report values for the store, from its first matched screen. Shown over the sheet values, never written into
    them unless someone presses Overwrite. Empty text and None mean the report has no value: the sheet's shows."""

    store_name: str = ""
    venue_name: str = ""
    address: str = ""
    addr: str = ""
    city: str = ""
    state: str = ""
    zip: str = ""
    lat: float | None = None
    lng: float | None = None
    dma: str = ""
    venue_type: str = ""
    date: str = ""


class DeviceSyncState(ApiModel):
    """The project's last sync, kept on its META."""

    pa: str
    snapshot_date: str  # the report day the sync read
    ingested_at: str = ""
    synced_at: str
    matched_screens: int = 0
    status_changes: int = 0  # screens whose work status the last sync changed
    review_count: int = 0  # records not in the project, not snoozed
    not_reporting: int = 0  # stores flagged "Completed but not in Dolphin data"


class ReviewItem(DeviceRecord):
    """A report record whose venue is not in the project yet. `snoozed_date`: "Not now" until a newer report day."""

    key: str  # venue_code_key(venue_id)
    snoozed_date: str = ""
