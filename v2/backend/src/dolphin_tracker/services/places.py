"""Single-address Google lookups for the UI: verify one address, autocomplete a partial one."""
from __future__ import annotations

from typing import Any

from dolphin_tracker.services.geocoding import GoogleGeocoder, resolve_address


class PlacesService:
    def __init__(self, geocoder: GoogleGeocoder) -> None:
        self._geocoder = geocoder

    def validate(self, address: str, name: str = "") -> dict[str, Any]:
        """Check one address as a person would in Google (see `resolve_address`); `name` is the store's name, so
        the business itself can place it. Verified, partial or failed (with Maps' suggestions)."""
        return resolve_address(self._geocoder, address.strip(), name)

    def autocomplete(self, query: str) -> list[str]:
        return self._geocoder.autocomplete(query.strip())

    def search(self, address: str, name: str = "") -> list[dict[str, Any]]:
        """What Google Search lists for the store: the store name with its address first, then the address alone
        (the businesses around it). One entry per place, at most ten."""
        queries = [f"{name.strip()}, {address.strip()}" if name.strip() else "", address.strip()]
        seen: set[str] = set()
        hits: list[dict[str, Any]] = []
        for query in (q for q in queries if q):
            for hit in self._geocoder.search_places(query):
                key = hit.get("place_id") or f"{hit['lat']:.5f},{hit['lng']:.5f}"
                if key not in seen:
                    seen.add(key)
                    hits.append(hit)
        return hits[:10]
