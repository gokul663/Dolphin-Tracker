"""Device sync use cases: pick a project's PA in the device report, sync it (on open when the report has a newer day,
on "Sync now", and daily from the worker), review report records the project lacks, check screens of another PA at
the stores' addresses, overwrite sheet values with the report's, and ignore a "not in CMS data" alert until the
next report day. Rules: `domain/device_sync.py`."""
from __future__ import annotations

import logging
from typing import Any

from dolphin_tracker.domain.base import ApiModel
from dolphin_tracker.domain.cms_log import SOURCE as CMS_LOG_SOURCE
from dolphin_tracker.domain.cursors import encode_cursor, offset_from_cursor
from dolphin_tracker.domain.device import (
    DeviceLog,
    DeviceSnapshot,
    DeviceSyncState,
    OtherPaScreen,
    ReviewItem,
    StoreDevice,
    split_codes,
    venue_code_key,
)
from dolphin_tracker.domain.device_sync import (
    OVERWRITABLE,
    add_record_changes,
    index_records,
    other_pa_screens,
    other_pa_situation,
    overwrite_changes,
    placeholder_screen,
    review_items,
    store_for_record,
    store_with_code,
    stores_from_records,
    sync_stop,
)
from dolphin_tracker.domain.errors import ConflictError, NotFoundError, ValidationFailed
from dolphin_tracker.domain.models import (
    NeedsAttention,
    Project,
    ScreenInput,
    Stop,
    StopInput,
    now_iso,
)
from dolphin_tracker.domain.search import matches, search_text
from dolphin_tracker.domain.venues import VENUES_PROJECT_ID
from dolphin_tracker.repositories.device_data import DeviceDataSource, DeviceDataUnavailable
from dolphin_tracker.repositories.device_review import DeviceReviewRepository
from dolphin_tracker.repositories.projects import ProjectRepository
from dolphin_tracker.repositories.stores import StoreRepository
from dolphin_tracker.services.geocoding import Geocoder, resolve_address
from dolphin_tracker.services.stores import StoreService
from dolphin_tracker.services.venues import VenueCatalogService

logger = logging.getLogger(__name__)


class PaList(ApiModel):
    date: str  # the report day the names come from
    pas: list[str]


class SyncResult(ApiModel):
    synced: bool  # False: the project already had the report's newest day (only_if_stale)
    state: DeviceSyncState | None
    stores_updated: int = 0


class PopulateResult(ApiModel):
    stores_added: int  # new stores built from the report's records
    sync: SyncResult  # the sync that ran right after, on the same report day


class ReviewPage(ApiModel):
    items: list[ReviewItem]
    next_cursor: str | None = None
    total: int
    snoozed: int  # hidden by "Not now" until the next report day


class OtherPaPage(ApiModel):
    items: list[OtherPaScreen]
    next_cursor: str | None = None
    total: int


class LogPage(ApiModel):
    items: list[DeviceLog]
    next_cursor: str | None = None
    total: int
    codes: list[str]  # the store's DD codes, as written on its screens (the filter's choices)


class OverwriteResult(ApiModel):
    stores_updated: int


class DeviceSyncService:
    def __init__(
        self,
        projects: ProjectRepository,
        stores: StoreRepository,
        reviews: DeviceReviewRepository,
        source: DeviceDataSource | None,
        store_service: StoreService | None = None,
        geocoder: Geocoder | None = None,
    ) -> None:
        self._venues = VenueCatalogService(stores, source)
        self._geocoder = geocoder
        self._projects = projects
        self._stores = stores
        self._reviews = reviews
        self._source = source
        self._store_service = store_service or StoreService(stores, projects)

    def _project(self, project_id: str) -> Project:
        project = self._projects.get(project_id)
        if project is None:
            raise NotFoundError(f"Project {project_id} not found")
        return project

    def _require_source(self) -> DeviceDataSource:
        if self._source is None:
            raise DeviceDataUnavailable("Device data is not configured (set DT_MONGO_URI locally)")
        return self._source

    # ---- the report -------------------------------------------------------------------------------------

    def list_pas(self) -> PaList:
        date, pas = self._require_source().list_pas()
        return PaList(date=date, pas=pas)

    # ---- sync -------------------------------------------------------------------------------------------

    def sync(self, project_id: str, *, only_if_stale: bool = False) -> SyncResult:
        project = self._project(project_id)
        pa = project.device_pa.strip()
        if not pa:
            raise ValidationFailed("Choose this project's PA for device data in Settings first")
        source = self._require_source()
        state = project.device_sync
        if only_if_stale and state is not None and state.pa == pa and state.snapshot_date >= source.latest_date():
            return SyncResult(synced=False, state=state)

        return self._apply(project_id, pa, source.snapshot(pa))

    def populate(self, project_id: str) -> PopulateResult:
        """Build the project's stores from the report alone (no sheet): every record of the PA's newest day that no
        store has becomes a store, then the sync runs on that day. Safe to repeat: stores already there are kept,
        and a record that belongs to one of them stays in review for Add."""
        project = self._project(project_id)
        pa = project.device_pa.strip()
        if not pa:
            raise ValidationFailed("Choose this project's PA for device data first")
        snapshot = self._require_source().snapshot(pa)
        inputs = stores_from_records(snapshot.records, self._stores.list_all(project_id))
        added = self._store_service.append(project_id, inputs)["appended"] if inputs else 0
        return PopulateResult(stores_added=added, sync=self._apply(project_id, pa, snapshot))

    def _apply(self, project_id: str, pa: str, snapshot: DeviceSnapshot) -> SyncResult:
        """One sync against a snapshot already read."""
        venues: dict[str, Stop] | None = None
        try:  # the planner's all-venues list takes this PA's latest too; it never fails the project's sync
            venues = {stop.uid: stop for stop in self._stores.list_all(VENUES_PROJECT_ID)}
            self._venues.upsert(snapshot.records, venues)
        except Exception:
            venues = None
            logger.exception("Could not update the all-venues list")
        codes = index_records(snapshot.records)
        now = now_iso()
        stops = self._stores.list_all(project_id)
        writes: list[tuple[str, dict[str, Any]]] = []
        located: list[Stop] = []  # the stores with this sync's CMS data address, for the other-PA check
        status_changes = matched = flagged = 0
        for stop in stops:
            changes = sync_stop(stop, codes, snapshot, now)
            if changes:
                writes.append((stop.uid, changes))
            if "device" in changes:
                device = StoreDevice.model_validate(changes["device"]) if changes["device"] else None
                located.append(stop.model_copy(update={"device": device}))
            else:
                located.append(stop)
            for screen in changes.get("screens") or []:
                status_changes += int(screen.get("status_changed_at") == now)
            matched += sum(1 for screen in stop.screens if venue_code_key(screen.venue_id) in codes)
            reasons = changes.get("needs_attention", stop.needs_attention)
            flagged += int(NeedsAttention.NOT_REPORTING.value in [str(reason) for reason in reasons])
        written = self._stores.update_device_many(project_id, writes)

        snoozed = {item.key: item.snoozed_date for item in self._reviews.list(project_id) if item.snoozed_date}
        items = review_items(snapshot.records, stops, snoozed, snapshot.date)
        self._reviews.replace(project_id, items)
        if venues is None:  # the all-venues list could not be read: the last list stands
            other_pa = len(self._reviews.list_other_pa(project_id))
        else:
            other = other_pa_screens(venues.values(), located, pa, self._reviews.reviewed_other_pa(project_id))
            self._reviews.replace_other_pa(project_id, other)
            other_pa = len(other)
        state = DeviceSyncState(
            pa=pa, snapshot_date=snapshot.date, ingested_at=snapshot.ingested_at, synced_at=now,
            matched_screens=matched, status_changes=status_changes,
            review_count=sum(1 for item in items if not item.snoozed_date), not_reporting=flagged,
            other_pa_count=other_pa,
        )
        self._projects.update(project_id, {"device_sync": state.model_dump(mode="json")})
        return SyncResult(synced=True, state=state, stores_updated=written)

    def refresh_venues(self) -> dict[str, Any]:
        """Bring the planner's all-venues list up to date with every PA of the report."""
        return self._venues.refresh_all().model_dump()

    def sync_all(self) -> dict[str, Any]:
        """Every project with a PA chosen (the daily schedule). One project failing does not stop the others."""
        # First every venue of every PA, for the Route Planner (domain/venues.py) and for each project's check of
        # the screens of another PA at its addresses, so that check reads the same report day as the sync.
        try:
            venues: dict[str, Any] = self._venues.refresh_all().model_dump()
        except Exception as exc:
            venues = {"error": f"{type(exc).__name__}: {exc}"}
        synced, failed, cursor = 0, [], None
        while True:
            page = self._projects.list(limit=100, cursor=cursor)
            for project in page.items:
                if not project.device_pa.strip():
                    continue
                try:
                    self.sync(project.id, only_if_stale=True)
                    synced += 1
                except Exception as exc:  # reported, then the next project
                    failed.append({"project_id": project.id, "error": f"{type(exc).__name__}: {exc}"})
            cursor = page.next_cursor
            if not cursor:
                break
        return {"synced": synced, "failed": failed, "venues": venues}

    # ---- review -----------------------------------------------------------------------------------------

    def review(
        self, project_id: str, *, include_snoozed: bool = False, limit: int = 50, cursor: str | None = None,
        q: str = "",
    ) -> ReviewPage:
        """The records waiting for review. `q` narrows them like the store search does: ExtID, store and CMS name,
        DD code, stick number and address."""
        self._project(project_id)
        items = self._reviews.list(project_id)
        if q.strip():
            items = [item for item in items if matches(q, search_text((
                item.external_id, item.store_name, item.venue_name, item.venue_id, item.serial_number, item.address,
                item.addr, item.city, item.state, item.zip,
            )))]
        items.sort(key=lambda item: (item.store_name.lower() or "~", item.key))
        snoozed = sum(1 for item in items if item.snoozed_date)
        shown = items if include_snoozed else [item for item in items if not item.snoozed_date]
        start = offset_from_cursor(cursor)
        window = shown[start : start + limit]
        next_cursor = encode_cursor({"offset": start + limit}) if start + limit < len(shown) else None
        return ReviewPage(items=window, next_cursor=next_cursor, total=len(shown), snoozed=snoozed)

    def _review_item(self, project_id: str, key: str) -> ReviewItem:
        item = self._reviews.get(project_id, venue_code_key(key))
        if item is None:
            raise NotFoundError("That record is no longer waiting for review")
        return item

    def _recount(self, project_id: str) -> None:
        project = self._project(project_id)
        if project.device_sync is None:
            return
        count = sum(1 for item in self._reviews.list(project_id) if not item.snoozed_date)
        not_reporting = sum(
            1 for row in self._stores.list_projected(project_id, ("needs_attention",))
            if NeedsAttention.NOT_REPORTING.value in (row.get("needs_attention") or [])
        )
        state = project.device_sync.model_copy(update={
            "review_count": count, "not_reporting": not_reporting,
            "other_pa_count": len(self._reviews.list_other_pa(project_id)),
        })
        self._projects.update(project_id, {"device_sync": state.model_dump(mode="json")})

    def snooze(self, project_id: str, key: str) -> ReviewItem:
        """"Not now": hidden until the next report day, then it shows again."""
        project = self._project(project_id)
        item = self._review_item(project_id, key)
        item = item.model_copy(update={"snoozed_date": project.device_sync.snapshot_date if project.device_sync
                                       else item.date})
        self._reviews.put(project_id, item)
        self._recount(project_id)
        return item

    def other_pa(self, project_id: str, *, limit: int = 50, cursor: str | None = None) -> OtherPaPage:
        """Screens of another PA (or none) at the address of one of the stores, as of the last sync; the ones
        marked reviewed are not listed."""
        self._project(project_id)
        items = self._reviews.list_other_pa(project_id)
        items.sort(key=lambda item: (item.store_name.lower() or "~", item.key))
        start = offset_from_cursor(cursor)
        next_cursor = encode_cursor({"offset": start + limit}) if start + limit < len(items) else None
        return OtherPaPage(items=items[start : start + limit], next_cursor=next_cursor, total=len(items))

    def mark_other_pa_reviewed(self, project_id: str, key: str) -> OtherPaScreen:
        """"Reviewed, it's fine": hidden for good, for this screen at this store under this PA. Nothing in the
        project changes; a new PA or another store of ours lists it again."""
        self._project(project_id)
        item = self._reviews.get_other_pa(project_id, key)
        if item is None:
            raise NotFoundError("That screen is no longer listed for review")
        self._reviews.mark_other_pa_reviewed(project_id, other_pa_situation(item))
        self._reviews.delete_other_pa(project_id, key)
        self._recount(project_id)
        return item

    def add_from_review(
        self, project_id: str, key: str, *, address: str = "", place: dict[str, Any] | None = None,
        add_anyway: bool = False,
    ) -> Stop:
        """Add the report's stick to the project. The DD code is the key: a store can hold several sticks, so when a
        store is already there (same ExtID, or the same address as its sheet or its CMS data) the stick joins it
        as a new screen. Otherwise the address is checked with Google like an imported row (the report's address,
        or `address` / a picked Google `place` from the person); one that cannot be verified is refused with
        Google's suggestions, unless `add_anyway` (the store is then flagged for an address check)."""
        project = self._project(project_id)
        item = self._review_item(project_id, key)
        stops = self._stores.list_all(project_id)
        holder = store_with_code(item.key, stops)
        if holder is not None:
            # The list is as of the last sync: the code was put on a store since (typed in, imported). Never a
            # second copy: that store is the answer, and the record is applied to its screen.
            stop = holder
        elif (existing := store_for_record(item, stops)) is None:
            located = self._locate(item, address, place, add_anyway)
            item_at = item.model_copy(update=located) if located else item
            existing = store_for_record(item_at, stops) if located else None  # the address joins a known store
            stop = self._add_screen(project_id, existing, item, stops) if existing else self._create_store(
                project_id, item_at, verified=bool(located))
        else:
            stop = self._add_screen(project_id, existing, item, stops)

        state = project.device_sync
        snapshot = DeviceSnapshot(
            pa=state.pa if state else item.pa_name, date=item.date,
            ingested_at=state.ingested_at if state else "", records=[item],
        )
        changes = add_record_changes(stop, item, snapshot, now_iso())
        if changes:
            self._stores.update_device_many(project_id, [(stop.uid, changes)])
        self._reviews.delete(project_id, item.key)
        self._recount(project_id)
        added = self._stores.get(project_id, stop.uid)
        assert added is not None
        return added

    def _locate(
        self, item: ReviewItem, address: str, place: dict[str, Any] | None, add_anyway: bool
    ) -> dict[str, Any] | None:
        """The verified address for a new store: a picked place as is, else Google's check of the typed or reported
        address. None with `add_anyway` when it cannot be verified; otherwise ValidationFailed with suggestions."""
        if place:
            return {
                "addr": place.get("addr") or item.addr, "city": place.get("city") or item.city,
                "state": place.get("state") or item.state, "zip": place.get("zip") or item.zip,
                "lat": place["lat"], "lng": place["lng"], "address": place.get("formatted") or item.address,
            }
        reported = (item.address or ", ".join(
            part for part in (item.addr, item.city, " ".join(filter(None, (item.state, item.zip)))) if part
        )) if item.addr else ""  # a city or state alone is no address to check
        line = address.strip() or reported
        name = item.store_name or item.venue_name
        if line and self._geocoder is not None:
            geo = resolve_address(self._geocoder, line, name)
            if geo.get("ok") and not geo.get("partial"):
                street = geo.get("addr") or line.split(",")[0].strip()
                return {"addr": street, "city": geo.get("city") or "", "state": geo.get("state") or "",
                        "zip": geo.get("zip") or "", "lat": geo["lat"], "lng": geo["lng"],
                        "address": geo.get("formatted") or line}
            suggestions = geo.get("suggestions") or []
        else:
            suggestions = []
        if add_anyway:
            return None
        message = ("Google could not verify this address. Pick a suggestion, search Google, or add it anyway."
                   if line else "The report has no address for this store. Enter one, search Google, or add it anyway.")
        raise ValidationFailed(message, suggestions=suggestions, address=line)

    def _add_screen(self, project_id: str, stop: Stop, item: ReviewItem, stops: list[Stop]) -> Stop:
        """The stick joins the store: it fills a row waiting for a DD code (the sheet's "3 screens" with no codes
        yet) when there is one, and only becomes a new row when there is none left."""
        waiting = placeholder_screen(stop.screens, item)
        rows = [ScreenInput(**screen.model_dump(exclude={"device", "status_changed_at"})) for screen in stop.screens]
        if waiting is None:
            rows.append(ScreenInput(venue_id=item.venue_id, stick_number=item.serial_number))
        else:
            rows = [
                row.model_copy(update={"venue_id": item.venue_id,
                                       "stick_number": row.stick_number.strip() or item.serial_number})
                if row.id == waiting.id else row
                for row in rows
            ]
        return self._store_service.update_screens(project_id, stop.uid, rows, updated_by="CMS data", stops=stops)

    def _create_store(self, project_id: str, item: ReviewItem, *, verified: bool) -> Stop:
        located = verified and item.lat is not None and item.lng is not None and bool(item.addr)
        attention = [] if located else [NeedsAttention.ADDRESS]
        if not item.external_id:  # the CMS has no ExtID for it: never invent one, ask for it on the store
            attention.append(NeedsAttention.EXTERNAL_ID)
        name = item.store_name or item.venue_name
        if not name:
            attention.append(NeedsAttention.STORE_NAME)
        stop_input = StopInput(
            external_id=item.external_id,
            store_name=name,
            addr=item.addr,
            city=item.city,
            state=item.state,
            zip=item.zip,
            dma=item.dma,
            venue_type=item.venue_type,
            lat=item.lat if located else None,
            lng=item.lng if located else None,
            geocoded=item.address if located else "",
            screens=[ScreenInput(venue_id=item.venue_id, stick_number=item.serial_number)],
            needs_attention=attention,
        )
        result = self._store_service.append(project_id, [stop_input])
        if not result["appended"]:  # store_for_record found nothing, so only a race lands here
            raise ConflictError("Not added: a matching store appeared meanwhile; try again")
        return next(
            stop for stop in self._stores.list_all(project_id)
            if any(venue_code_key(screen.venue_id) == item.key for screen in stop.screens)
        )

    # ---- per store --------------------------------------------------------------------------------------

    def logs(
        self, project_id: str, stop_uid: str, *, dd_code: str = "", limit: int = 50, cursor: str | None = None
    ) -> LogPage:
        """The CMS's servicing log entries for the store's DD codes, newest first; `dd_code` narrows to one of
        them. Matched by DD code only: a store without one has no logs here."""
        self._project(project_id)
        stop = self._store_service.get(project_id, stop_uid)
        codes = list(dict.fromkeys(
            code.strip() for screen in stop.screens for code in split_codes(screen.venue_id) if venue_code_key(code)
        ))
        wanted = codes
        if dd_code.strip():
            key = venue_code_key(dd_code)
            wanted = [code for code in codes if venue_code_key(code) == key]
            if not wanted:
                raise ValidationFailed(f"{dd_code.strip()} is not a DD code of this store")
        logs = self._require_source().logs(wanted) if wanted else []
        # Tracker's own entries are in the collection too (domain/cms_log.py); the store's log already lists them
        # from Tracker, so here they would show twice.
        logs = [log for log in logs if log.source != CMS_LOG_SOURCE]
        start = offset_from_cursor(cursor)
        next_cursor = encode_cursor({"offset": start + limit}) if start + limit < len(logs) else None
        return LogPage(items=logs[start : start + limit], next_cursor=next_cursor, total=len(logs), codes=codes)

    def ignore_alert(self, project_id: str, stop_uid: str) -> Stop:
        """Hide "not in CMS data" for this store until the next report day."""
        project = self._project(project_id)
        stop = self._store_service.get(project_id, stop_uid)
        if project.device_sync is None:
            raise ValidationFailed("This project has not synced device data yet")
        reasons = [str(reason) for reason in stop.needs_attention if reason != NeedsAttention.NOT_REPORTING]
        self._stores.update_device_many(project_id, [(stop_uid, {
            "device_alert_ignored": project.device_sync.snapshot_date, "needs_attention": reasons,
        })])
        self._recount(project_id)
        updated = self._stores.get(project_id, stop_uid)
        assert updated is not None
        return updated

    def overwrite(self, project_id: str, fields: list[str], stop_uid: str | None = None) -> OverwriteResult:
        """Copy the report's values into the stores' own fields: one store, or every synced store."""
        self._project(project_id)
        unknown = set(fields) - set(OVERWRITABLE)
        if unknown or not fields:
            raise ValidationFailed(f"Choose fields from {', '.join(OVERWRITABLE)}")
        stops = [self._store_service.get(project_id, stop_uid)] if stop_uid else self._stores.list_all(project_id)
        updated = 0
        for stop in stops:
            changes = overwrite_changes(stop, fields)
            if changes:
                self._stores.update_fields(project_id, stop.uid, changes)
                updated += 1
        return OverwriteResult(stores_updated=updated)
