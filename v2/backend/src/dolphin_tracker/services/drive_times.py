"""Driving times between consecutive points, from the Google Routes API (computeRoutes).

One request covers up to 27 points (origin, 25 intermediates, destination) and returns one leg per pair, so a
route of n points costs about n / 26 requests. Windows run in parallel. A window that fails (no key, quota, network)
falls back to the straight-line estimate, so planning never fails because Google did."""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor

import httpx

from dolphin_tracker.domain.route_plans import Point, estimate_leg_minutes

ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
MAX_POINTS = 27  # origin + 25 intermediates + destination
WORKERS = 8

log = logging.getLogger(__name__)


def _waypoint(point: Point) -> dict:
    return {"location": {"latLng": {"latitude": point[0], "longitude": point[1]}}}


def _seconds(value: str | None) -> float:
    return float(value.rstrip("s")) if value else 0.0


def windows(points: list[Point]) -> list[list[Point]]:
    """Consecutive windows of at most MAX_POINTS points, each starting where the last ended."""
    return [points[i : i + MAX_POINTS] for i in range(0, len(points) - 1, MAX_POINTS - 1)]


class GoogleDriveTimes:
    """Callable: points → minutes for each consecutive leg (len(points) - 1 values)."""

    def __init__(self, api_key: str, *, client: httpx.Client | None = None, timeout: float = 10.0) -> None:
        self._key = api_key
        self._client = client or httpx.Client(timeout=timeout)

    def _window(self, points: list[Point]) -> list[float]:
        body = {
            "origin": _waypoint(points[0]),
            "destination": _waypoint(points[-1]),
            "intermediates": [_waypoint(point) for point in points[1:-1]],
            "travelMode": "DRIVE",
        }
        headers = {"X-Goog-Api-Key": self._key, "X-Goog-FieldMask": "routes.legs.duration"}
        try:
            response = self._client.post(ROUTES_URL, json=body, headers=headers)
            response.raise_for_status()
            legs = response.json()["routes"][0]["legs"]
            if len(legs) != len(points) - 1:
                raise ValueError(f"expected {len(points) - 1} legs, got {len(legs)}")
            return [_seconds(leg.get("duration")) / 60 for leg in legs]
        except Exception as exc:  # network, quota, no route: plan with the estimate rather than fail
            log.warning("Routes API failed for %d points, using the straight-line estimate: %s", len(points), exc)
            return estimate_leg_minutes(points)

    def __call__(self, points: list[Point]) -> list[float]:
        if len(points) < 2:
            return []
        if not self._key:
            return estimate_leg_minutes(points)
        parts = windows(points)
        with ThreadPoolExecutor(max_workers=min(WORKERS, len(parts))) as pool:
            return [minutes for part in pool.map(self._window, parts) for minutes in part]
