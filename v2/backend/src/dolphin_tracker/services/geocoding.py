"""Google Geocoding and Places lookups, ported from v1 server.py onto httpx."""
from __future__ import annotations

import re
from typing import Any, Protocol

import httpx

from dolphin_tracker.domain.addresses import parse_us_formatted_address

GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"
AUTOCOMPLETE_URL = "https://maps.googleapis.com/maps/api/place/autocomplete/json"
FIND_PLACE_URL = "https://maps.googleapis.com/maps/api/place/findplacefromtext/json"
PLACE_DETAILS_URL = "https://maps.googleapis.com/maps/api/place/details/json"
TEXT_SEARCH_URL = "https://maps.googleapis.com/maps/api/place/textsearch/json"


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
    def place_details(self, place_id: str) -> dict[str, Any]: ...
    def find_place(self, query: str) -> dict[str, Any]: ...
    def autocomplete(self, query: str) -> list[str]: ...
    def autocomplete_places(self, query: str) -> list[dict[str, str]]: ...
    def search_places(self, query: str) -> list[dict[str, Any]]: ...


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
        return self._geocode({"address": address})

    def place_details(self, place_id: str) -> dict[str, Any]:
        """Where a place Autocomplete suggested is, in the geocode() shape. `exact` is True when Google knows the
        house (a street number), False when it only knows the road."""
        if not self.enabled or not place_id:
            return {"ok": False, "error": "missing key/place"}
        try:
            data = self._client.get(
                PLACE_DETAILS_URL,
                params={
                    "place_id": place_id,
                    "fields": "formatted_address,geometry,address_component",
                    "key": self._key,
                },
            ).json()
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
        result = data.get("result") or {}
        location = (result.get("geometry") or {}).get("location") or {}
        if data.get("status") != "OK" or "lat" not in location:
            return {"ok": False, "status": data.get("status"), "error": data.get("error_message", "")}
        parts = google_address_parts(result)
        exact = any("street_number" in c.get("types", []) for c in result.get("address_components", []))
        return {
            "ok": True,
            "status": "OK",
            "formatted": result.get("formatted_address", ""),
            "lat": location["lat"],
            "lng": location["lng"],
            **parts,
            "partial": False,
            "exact": exact,
            "suggestions": [],
        }

    def _geocode(self, params: dict[str, str]) -> dict[str, Any]:
        try:
            data = self._client.get(GEOCODE_URL, params={**params, "key": self._key}).json()
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
        return [prediction["description"] for prediction in self.autocomplete_places(query)]

    def autocomplete_places(self, query: str) -> list[dict[str, str]]:
        """What Google Maps suggests while typing (addresses only, US): description and place id."""
        if not self.enabled or not query.strip():
            return []
        try:
            data = self._client.get(
                AUTOCOMPLETE_URL,
                params={"input": query, "key": self._key, "types": "address", "components": "country:us"},
            ).json()
        except Exception:
            return []
        return [
            {"description": prediction.get("description", ""), "place_id": prediction.get("place_id", "")}
            for prediction in data.get("predictions", [])
        ][:6]

    def search_places(self, query: str) -> list[dict[str, Any]]:
        """Places for a free-text query, as Google Search lists them: name, address and exact pin."""
        if not self.enabled or not query.strip():
            return []
        try:
            data = self._client.get(TEXT_SEARCH_URL, params={"query": query, "region": "us", "key": self._key}).json()
        except Exception:
            return []
        hits = []
        for result in data.get("results", [])[:10]:
            location = (result.get("geometry") or {}).get("location") or {}
            if "lat" not in location:
                continue
            formatted = result.get("formatted_address", "")
            parts = parse_us_formatted_address(formatted)
            hits.append({
                "place_id": result.get("place_id", ""),
                "name": result.get("name", ""),
                "formatted": formatted,
                "lat": location["lat"],
                "lng": location["lng"],
                "addr": parts.get("addr", ""),
                "city": parts.get("city", ""),
                "state": parts.get("state", ""),
                "zip": parts.get("zip", ""),
            })
        return hits

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


# ---- resolving an address: as a person would check it in Google ------------------------------------------------

STREET_WORDS = {
    "n": "north", "s": "south", "e": "east", "w": "west", "ne": "northeast", "nw": "northwest", "se": "southeast",
    "sw": "southwest", "rd": "road", "st": "street", "ave": "avenue", "av": "avenue", "blvd": "boulevard",
    "dr": "drive", "ln": "lane", "ct": "court", "pl": "place", "pkwy": "parkway", "hwy": "highway", "cir": "circle",
    "ter": "terrace", "trl": "trail", "sr": "state road", "fm": "farm to market", "us": "us", "ste": "suite",
}

US_STATES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA", "colorado": "CO",
    "connecticut": "CT", "delaware": "DE", "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
    "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS", "kentucky": "KY", "louisiana": "LA",
    "maine": "ME", "maryland": "MD", "massachusetts": "MA", "michigan": "MI", "minnesota": "MN",
    "mississippi": "MS", "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC",
    "north dakota": "ND", "ohio": "OH", "oklahoma": "OK", "oregon": "OR", "pennsylvania": "PA",
    "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", "tennessee": "TN", "texas": "TX",
    "utah": "UT", "vermont": "VT", "virginia": "VA", "washington": "WA", "west virginia": "WV",
    "wisconsin": "WI", "wyoming": "WY",
}
STATE_CODES = frozenset(US_STATES.values())

# "E Highway 40", "State Road 40", "SR-40", "State Hwy 40", "FL 40", "Florida 40": a state highway, written the way
# Google stores it ("FL-40"). US and interstate highways are left alone (Google reads those as typed).
STATE_HIGHWAY = re.compile(
    r"^(?P<number>\d+[a-z]?)\s+(?:(?:n|s|e|w|north|south|east|west)\.?\s+)?"
    r"(?:state\s+(?:road|route|highway|hwy|rd)|highway|hwy|s\.?r\.?|[a-z]{2}|[a-z]+(?:\s[a-z]+)?)[\s-]*(?P<route>\d+[a-z]?)"
    r"(?:\s+(?:n|s|e|w|north|south|east|west))?$",
    re.IGNORECASE,
)


def street_key(address: str) -> str:
    """The street line (before the first comma), lower case, punctuation gone, abbreviations spelled out:
    "101 W State Rd. 60" and "101 West State Road 60" give the same key."""
    line = address.split(",")[0].lower()
    words = re.sub(r"[^a-z0-9 ]+", " ", line).split()
    return " ".join(STREET_WORDS.get(word, word) for word in words)


def zip_of(address: str) -> str:
    """The ZIP, read after the street line only: a five-digit house number ("10777 E Highway 40") is not a ZIP."""
    _, _, rest = address.partition(",")
    found = re.findall(r"\b(\d{5})(?:-\d{4})?\b", rest)
    return found[-1] if found else ""


def house_number(address: str) -> str:
    first = street_key(address).split(" ", 1)[0]
    return first if first.isdigit() else ""


def state_of(address: str) -> str:
    """The two-letter state of a US address ("…, Florida 34488" or "…, FL 34488"), else ""."""
    for part in reversed([part.strip() for part in address.split(",")[1:]]):
        words = re.sub(r"\d{5}(-\d{4})?", "", part).strip().lower()
        if words.upper() in STATE_CODES:
            return words.upper()
        if words in US_STATES:
            return US_STATES[words]
    return ""


def state_highway_variant(address: str) -> str:
    """The address with a state highway written as Google stores it ("10777 E Highway 40, …, FL" → "10777 FL-40,
    …"), or "" when the street is not a state highway (or the state is unknown)."""
    street, _, rest = address.partition(",")
    state = state_of(address)
    match = STATE_HIGHWAY.match(street.strip())
    if not state or not match:
        return ""
    middle = street.strip()[len(match.group("number")) :].lower()
    if re.search(r"\b(us|u\.s\.|interstate|i)\b", middle):
        return ""  # US 41, I-75: not a state road
    named = re.sub(r"[\s\-\d.]+", " ", middle).split()
    words = [w for w in named if w not in {"n", "s", "e", "w", "north", "south", "east", "west"}]
    road_words = {"state", "road", "route", "highway", "hwy", "rd", "sr", "s", "r"}
    state_names = set(state.lower().split()) | set(next(n for n, c in US_STATES.items() if c == state).split())
    if words and not all(w in road_words or w in state_names for w in words):
        return ""  # e.g. "10 Main 5": a named street, not a highway
    return f"{match.group('number')} {state}-{match.group('route').upper()},{rest}"


def same_address(typed: str, suggested: str) -> bool:
    """A suggestion is the typed address when the street lines match word for word (after spelling out
    abbreviations; a state highway in any spelling counts as the same road), both start with the same house
    number, and the ZIPs agree when both have one."""
    if not house_number(typed) or house_number(typed) != house_number(suggested):
        return False
    a, b = zip_of(typed), zip_of(suggested)
    if a and b and a != b:
        return False
    if street_key(typed) == street_key(suggested):
        return True
    typed_hw, suggested_hw = state_highway_variant(typed), state_highway_variant(suggested)
    return bool(typed_hw) and street_key(typed_hw) == street_key(suggested_hw)


NAME_NOISE = {"the", "inc", "llc", "co", "corp", "store", "#"}


def _name_words(name: str) -> set[str]:
    words = re.sub(r"[^a-z0-9 ]+", " ", name.lower().replace("&", " and ")).split()
    return {word for word in words if word not in NAME_NOISE}


def same_name(store: str, place: str) -> bool:
    """The place Google found is the store: "Sunset Gas & Grill" and "Sunset Gas And Grill" are; "Shell" and
    "Shell Gas Station" are (one name holds the other); "Shell" and "Chevron" are not."""
    a, b = _name_words(store), _name_words(place)
    if not a or not b:
        return False
    return a <= b or b <= a or len(a & b) / len(a | b) >= 0.6


def _town(address: str) -> str:
    """The city of a "street, city, state zip" address, lower case ("" when there is none)."""
    parts = [part.strip() for part in address.split(",")]
    for part in parts[1:]:
        cleaned = re.sub(r"\d{5}(-\d{4})?", "", part).strip().lower()
        if cleaned and cleaned.upper() not in STATE_CODES and cleaned not in US_STATES and cleaned not in ("usa", "us"):
            return cleaned
    return ""


def same_town(typed: str, other: str) -> bool:
    """Two addresses are in the same place when their ZIPs agree, else their towns (when both say)."""
    zips = zip_of(typed), zip_of(other)
    if all(zips):
        return zips[0] == zips[1]
    towns = _town(typed), _town(other)
    return not all(towns) or towns[0] == towns[1]


def _has_house(result: dict[str, Any], typed: str) -> bool:
    """A verified answer must carry the house number that was typed (Google sometimes answers "FL-40, Silver
    Springs" without a partial flag)."""
    number = house_number(typed)
    if not number:
        return True
    return house_number(result.get("addr") or "") == number or house_number(result.get("formatted") or "") == number


def _same_zip(result: dict[str, Any], typed: str) -> bool:
    """Google's answer lands in the typed ZIP (when both have one): a match in another town is not this store."""
    typed_zip = zip_of(typed)
    found = (result.get("zip") or "").strip()[:5] or zip_of(result.get("formatted") or "")
    return not typed_zip or not found or typed_zip == found


def _exact(geo: dict[str, Any], typed: str) -> bool:
    return bool(geo.get("ok")) and not geo.get("partial") and _has_house(geo, typed) and _same_zip(geo, typed)


def resolve_address(geocoder: Geocoder, address: str, name: str = "") -> dict[str, Any]:
    """Check an address the way a person checks it in Google, stopping at the first exact answer:

    1. Geocoding the address as typed (exact only with the typed house number).
    2. The business: the store name and the address as a place search, as Google Search does ("Forest Food & Fuel,
       10777 E Highway 40, …" → 10777 FL-40). It must have the same house number and ZIP.
    3. A state highway written as Google stores it ("E Highway 40" / "State Road 40" → "FL-40"), geocoded again.
    4. Google Maps' suggestions (Autocomplete): one that is the typed address, when Google knows that house.
    Otherwise the answer is partial or failed, with Maps' suggestions to pick from. `matched_by` says which step
    verified it ("" for the first)."""
    geo = geocoder.geocode(address)
    if _exact(geo, address):
        return geo
    if geo.get("ok") and not geo.get("partial"):
        geo = {**geo, "partial": True}  # Google answered without the house number, or in another ZIP

    if name.strip():
        place = geocoder.find_place(f"{name.strip()}, {address}")
        formatted = place.get("formatted") or ""
        zips = zip_of(address), zip_of(formatted)
        same_house = bool(house_number(address)) and house_number(formatted) == house_number(address)
        # Google sometimes knows a business only by its town ("Sunset Gas And Grill · Sunset, TX 76270"): then the
        # name has to be the store's and the place has to be in the typed town or ZIP.
        same_business = not house_number(formatted) and same_name(name, place.get("name") or "") and same_town(
            address, formatted
        )
        if (
            place.get("ok")
            and place.get("lat") is not None
            and (same_house or same_business)
            and (not all(zips) or zips[0] == zips[1])
        ):
            parts = parse_us_formatted_address(formatted)
            return {
                "ok": True, "status": "OK", "formatted": formatted, "lat": place["lat"], "lng": place["lng"],
                "addr": parts.get("addr", ""), "city": parts.get("city", ""), "state": parts.get("state", ""),
                "zip": parts.get("zip", ""), "partial": False, "suggestions": [], "matched_by": "places",
                "place_name": place.get("name") or "",
            }

    variant = state_highway_variant(address)
    if variant:
        rewritten = geocoder.geocode(variant)
        if _exact(rewritten, address):
            return {**rewritten, "matched_by": "state_highway"}

    # Suggestions in another town (e.g. "Texas 101, Chico" for an address in Sunset) are left out.
    predictions = [p for p in geocoder.autocomplete_places(address) if same_town(address, p.get("description", ""))]
    suggestions = [p["description"] for p in predictions if p.get("description")] or [
        s for s in geo.get("suggestions") or [] if same_town(address, s)
    ]
    for match in (p for p in predictions if p.get("place_id") and same_address(address, p.get("description", ""))):
        details = geocoder.place_details(match["place_id"])
        if details.get("ok") and details.get("exact") and _has_house(details, address) and _same_zip(details, address):
            return {**details, "partial": False, "suggestions": suggestions, "matched_by": "autocomplete"}
    return {**geo, "suggestions": suggestions}
