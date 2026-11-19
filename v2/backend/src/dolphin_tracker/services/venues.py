"""Keeps the Route Planner's list of every Dolphin venue up to date from the device report (domain/venues.py)."""
from __future__ import annotations

from collections.abc import Iterable

from dolphin_tracker.domain.base import ApiModel
from dolphin_tracker.domain.device import DeviceRecord
from dolphin_tracker.domain.models import Stop
from dolphin_tracker.domain.venues import CLOSED, VENUES_PROJECT_ID, refreshed, venue_stop
from dolphin_tracker.repositories.device_data import DeviceDataSource, DeviceDataUnavailable
from dolphin_tracker.repositories.stores import StoreRepository


class VenueRefresh(ApiModel):
    date: str = ""  # the report day read
    pas: int = 0
    venues: int = 0  # kept after this refresh
    added: int = 0
    updated: int = 0
    failed: list[str] = []  # PAs whose records could not be read (left as they were)


class VenueCatalogService:
    def __init__(self, stores: StoreRepository, source: DeviceDataSource | None) -> None:
        self._stores, self._source = stores, source

    def upsert(self, records: Iterable[DeviceRecord], existing: dict[str, Stop] | None = None) -> tuple[int, int]:
        """Bring the kept venues in line with these report records: new venues are added (not closed ones), the
        others take the report's latest details and status. Returns (added, updated). A venue the report no longer
        has is left as it is."""
        kept = existing if existing is not None else {s.uid: s for s in self._stores.list_all(VENUES_PROJECT_ID)}
        added: list[Stop] = []
        updated: list[Stop] = []
        for record in records:
            stop = venue_stop(record)
            if stop is None:
                continue
            old = kept.get(stop.uid)
            if old is None:
                if stop.status not in CLOSED:
                    added.append(stop)
                    kept[stop.uid] = stop
            else:
                changed = refreshed(old, stop)
                if changed is not None:
                    updated.append(changed)
                    kept[stop.uid] = changed
        if added or updated:
            self._stores.put_many(VENUES_PROJECT_ID, [*added, *updated])
        return len(added), len(updated)

    def refresh_all(self) -> VenueRefresh:
        """Every PA of the report's newest day. One PA failing does not stop the others."""
        if self._source is None:
            raise DeviceDataUnavailable("Device data is not configured (set DT_MONGO_URI locally)")
        date, pas = self._source.list_pas()
        kept = {stop.uid: stop for stop in self._stores.list_all(VENUES_PROJECT_ID)}
        result = VenueRefresh(date=date, pas=len(pas))
        for pa in pas:
            try:
                records = self._source.snapshot(pa).records
            except Exception:  # reported, then the next PA
                result.failed.append(pa)
                continue
            added, updated = self.upsert(records, kept)
            result.added += added
            result.updated += updated
        result.venues = sum(1 for stop in kept.values() if stop.status not in CLOSED)
        return result
