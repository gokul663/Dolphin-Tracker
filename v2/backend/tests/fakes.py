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
    ) -> None:
        self.geocodes = geocodes or {}
        self.places = places or {}
        self.autocompletes = autocomplete or {}
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
