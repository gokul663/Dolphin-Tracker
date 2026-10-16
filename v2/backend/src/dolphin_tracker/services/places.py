"""Single-address Google lookups for the UI: verify one address, autocomplete a partial one."""
from __future__ import annotations

from typing import Any

from dolphin_tracker.services.geocoding import GoogleGeocoder


class PlacesService:
    def __init__(self, geocoder: GoogleGeocoder) -> None:
        self._geocoder = geocoder

    def validate(self, address: str) -> dict[str, Any]:
        """Geocode one address. `ok=False` with suggestions when Google cannot place it."""
        result = self._geocoder.geocode(address.strip())
        if not result.get("ok") and not result.get("suggestions"):
            result = {**result, "suggestions": self._geocoder.autocomplete(address)}
        return result

    def autocomplete(self, query: str) -> list[str]:
        return self._geocoder.autocomplete(query.strip())
