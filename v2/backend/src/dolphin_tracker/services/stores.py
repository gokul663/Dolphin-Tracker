"""Store use cases: paginated listing, detail edits with geocode verification, progress updates. Phase 2."""
from __future__ import annotations

from typing import Any

from dolphin_tracker.domain.models import Page, Stop
from dolphin_tracker.repositories.stores import StoreRepository
from dolphin_tracker.services.geocoding import GoogleGeocoder


class StoreService:
    def __init__(self, stores: StoreRepository, geocoder: GoogleGeocoder | None = None) -> None:
        self._stores = stores
        self._geocoder = geocoder

    def list(self, project_id: str, *, limit: int = 50, cursor: str | None = None) -> Page[Stop]:
        return self._stores.list(project_id, limit=limit, cursor=cursor)

    def pins(self, project_id: str) -> list[dict[str, Any]]:
        """Lightweight whole-project payload for the map: uid, lat, lng, status, store_name."""
        return [
            {"uid": stop.uid, "lat": stop.lat, "lng": stop.lng, "status": stop.status, "store_name": stop.store_name}
            for stop in self._stores.list_all(project_id)
            if stop.lat is not None and stop.lng is not None
        ]

    def update_details(self, project_id: str, stop_uid: str, changes: dict[str, Any]) -> Stop:
        raise NotImplementedError("Phase 2: validate required name/address, geocode on address change, write")

    def update_progress(self, project_id: str, stop_uid: str, changes: dict[str, Any]) -> Stop:
        raise NotImplementedError("Phase 2: status/comment/additional_task/installer_name only")
