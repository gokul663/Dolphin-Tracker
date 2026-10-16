"""Google Geocoding and Places lookups, ported from v1 server.py onto httpx."""
from __future__ import annotations

from typing import Any, Protocol

import httpx

from dolphin_tracker.domain.addresses import parse_us_formatted_address

GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"
AUTOCOMPLETE_URL = "https://maps.googleapis.com/maps/api/place/autocomplete/json"
FIND_PLACE_URL = "https://maps.googleapis.com/maps/api/place/findplacefromtext/json"


def google_address_parts(result: dict[str, Any]) -> dict[str, str]:
    parts = {kind: "" for kind in ("street_number", "route", "locality", "administrative_area_level_1", "postal_code")}
    for component in result.get("address_components", []):
        types = component.get("types", [])
        for kind in parts:
            if kind in types:
                parts[kind] = component.get("short_name" if kind == "administrative_area_level_1" else "long_name", "")
    street = " ".join(filter(None, [parts["street_number"], parts["route"]])).strip()
    return {
        "addr": street,
        "city": parts["locality"],
        "state": parts["administrative_area_level_1"],
        "zip": parts["postal_code"],
    }


class Geocoder(Protocol):
    """What services need from GoogleGeocoder; tests pass a fake with the same methods."""

    def geocode(self, address: str) -> dict[str, Any]: ...
    def find_place(self, query: str) -> dict[str, Any]: ...
    def autocomplete(self, query: str) -> list[str]: ...


class GoogleGeocoder:
    """Synchronous client. Construct once per Lambda invocation or worker job and reuse."""

    def __init__(self, api_key: str, *, client: httpx.Client | None = None, timeout: float = 8.0) -> None:
        self._key = api_key
        self._client = client or httpx.Client(timeout=timeout)

    @property
    def enabled(self) -> bool:
        return bool(self._key)

    def close(self) -> None:
        self._client.close()

    def geocode(self, address: str) -> dict[str, Any]:
        if not self.enabled or not address.strip():
            return {"ok": False, "error": "missing key/address"}
        try:
            data = self._client.get(GEOCODE_URL, params={"address": address, "key": self._key}).json()
        except Exception as exc:  # network, JSON
            return {"ok": False, "error": str(exc)}
        status = data.get("status")
        results = data.get("results", [])
        if status == "OK" and results:
            top = results[0]
            location = top["geometry"]["location"]
            parsed = google_address_parts(top)
            if not parsed.get("addr"):
                parsed = parse_us_formatted_address(top.get("formatted_address", ""))
            return {
                "ok": True,
                "status": status,
                "formatted": top.get("formatted_address", ""),
                "lat": location["lat"],
                "lng": location["lng"],
                "addr": parsed.get("addr", ""),
                "city": parsed.get("city", ""),
                "state": parsed.get("state", ""),
                "zip": parsed.get("zip", ""),
                "partial": bool(top.get("partial_match")),
                "suggestions": [item.get("formatted_address", "") for item in results[:5]],
            }
        return {"ok": False, "status": status, "suggestions": [], "error": data.get("error_message", "")}

    def autocomplete(self, query: str) -> list[str]:
        if not self.enabled or not query.strip():
            return []
        try:
            data = self._client.get(
                AUTOCOMPLETE_URL,
                params={"input": query, "key": self._key, "types": "address", "components": "country:us"},
            ).json()
        except Exception:
            return []
        return [prediction.get("description", "") for prediction in data.get("predictions", [])][:6]

    def find_place(self, query: str) -> dict[str, Any]:
        """Confirm the address is a real place. Used only as a confidence signal, never as the route address."""
        if not self.enabled or not query.strip():
            return {"ok": False}
        try:
            data = self._client.get(
                FIND_PLACE_URL,
                params={
                    "input": query,
                    "inputtype": "textquery",
                    "fields": "formatted_address,name,geometry,place_id,business_status",
                    "key": self._key,
                },
            ).json()
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
        candidates = data.get("candidates", [])
        if data.get("status") == "OK" and candidates:
            top = candidates[0]
            location = top.get("geometry", {}).get("location", {})
            return {
                "ok": True,
                "place_id": top.get("place_id"),
                "name": top.get("name"),
                "formatted": top.get("formatted_address"),
                "lat": location.get("lat"),
                "lng": location.get("lng"),
                "business_status": top.get("business_status"),
            }
        return {"ok": False, "status": data.get("status")}
