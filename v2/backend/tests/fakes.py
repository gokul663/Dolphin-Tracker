"""Test doubles shared across test modules."""
from __future__ import annotations

import threading
from typing import Any


def geocode_ok(address: str, *, lat: float = 33.75, lng: float = -84.39, partial: bool = False, **parts: str) -> dict:
    """A successful GoogleGeocoder.geocode() result for `address`."""
    addr = parts.get("addr", address.split(",")[0].strip())
    city, state, zip_code = parts.get("city", "Atlanta"), parts.get("state", "GA"), parts.get("zip", "30303")
    return {
        "ok": True,
        "status": "OK",
        "formatted": f"{addr}, {city}, {state} {zip_code}, USA",
        "lat": lat,
        "lng": lng,
        "addr": addr,
        "city": city,
        "state": state,
        "zip": zip_code,
        "partial": partial,
        "suggestions": [f"{addr}, {city}, {state} {zip_code}, USA"],
    }


class FakeGeocoder:
    """Stands in for GoogleGeocoder. Unknown addresses fail like Google's ZERO_RESULTS.

    `geocodes` maps an exact address to a geocode() result; `places` maps a find_place() query to a result.
    Thread-safe call log, since the import job geocodes from a thread pool.
    """

    def __init__(
        self,
        geocodes: dict[str, dict] | None = None,
        places: dict[str, dict] | None = None,
        autocomplete: dict[str, list[str]] | None = None,
        details: dict[str, dict] | None = None,
        searches: dict[str, list[dict]] | None = None,
    ) -> None:
        self.geocodes = geocodes or {}
        self.places = places or {}
        self.autocompletes = autocomplete or {}
        self.details = details or {}  # place id (= the suggestion text) → place_details() result
        self.searches = searches or {}  # text query → search_places() hits
        self.calls: list[tuple[str, str]] = []
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return True

    def _log(self, kind: str, value: str) -> None:
        with self._lock:
            self.calls.append((kind, value))

    def geocode(self, address: str) -> dict[str, Any]:
        self._log("geocode", address)
        return self.geocodes.get(address, {"ok": False, "status": "ZERO_RESULTS", "suggestions": [], "error": ""})

    def autocomplete(self, query: str) -> list[str]:
        self._log("autocomplete", query)
        return self.autocompletes.get(query, [])

    def find_place(self, query: str) -> dict[str, Any]:
        self._log("find_place", query)
        return self.places.get(query, {"ok": False, "status": "ZERO_RESULTS"})

    def search_places(self, query: str) -> list[dict[str, Any]]:
        self._log("search_places", query)
        return self.searches.get(query, [])

    def autocomplete_places(self, query: str) -> list[dict[str, str]]:
        """Autocomplete with place ids: each suggestion's id is the suggestion itself (see `details`)."""
        self._log("autocomplete", query)
        return [{"description": text, "place_id": text} for text in self.autocompletes.get(query, [])]

    def place_details(self, place_id: str) -> dict[str, Any]:
        self._log("place_details", place_id)
        return self.details.get(place_id, {"ok": False, "status": "NOT_FOUND"})


def status_write(status, **extra):
    """An update_fields payload that sets every screen to `status` (status is derived from screens)."""
    from dolphin_tracker.domain.models import Screen

    return {"screens": [Screen(status=status).model_dump(mode="json")], "status": str(status), **extra}


def report_row(venue_id: str, status: str = "Online", **extra) -> dict:
    """One `dolphin-internal-report` document as Mongo returns it (only the fields the tracker reads)."""
    from datetime import datetime

    return {
        "Venue ID": venue_id,
        "Date": "11-09-2026",
        "Status": status,
        "Last Seen (UTC)": datetime(2026, 11, 9, 22, 3, 51),
        "Offline Days": 0,
        "Serial Number": f"SN-{venue_id}",
        "Venue Name": f"CMS_{venue_id}",
        "Store Name": f"Store {venue_id}",
        "Address": "5680 Stadium Dr, Kalamazoo, MI 49009",
        "City": "Kalamazoo",
        "State": "Michigan",
        "State Code": "MI",
        "Zip Code": "49009",
        "Latitude": 42.2675,
        "Longitude": -85.661,
        "PA Name": "IBC",
        "PK External ID": "",
        "ingested_at_utc": datetime(2026, 11, 10, 3, 2, 6),
        **extra,
    }


class FakeDeviceData:
    """Stands in for the device report: `rows` are report documents for the newest day, any PA."""

    def __init__(self, rows: list[dict] | None = None, date: str = "2026-11-09") -> None:
        self.rows = rows or []
        self.date = date
        self.snapshots: list[str] = []

    def latest_date(self) -> str:
        return self.date

    def list_pas(self) -> tuple[str, list[str]]:
        return self.date, sorted({row["PA Name"] for row in self.rows})

    def snapshot(self, pa: str):
        from dolphin_tracker.domain.device import DeviceRecord, DeviceSnapshot, utc_iso

        self.snapshots.append(pa)
        rows = [row for row in self.rows if row["PA Name"] == pa]
        ingested = max((utc_iso(row["ingested_at_utc"]) for row in rows), default="")
        return DeviceSnapshot(pa=pa, date=self.date, ingested_at=ingested,
                              records=[DeviceRecord.from_report(row) for row in rows])
