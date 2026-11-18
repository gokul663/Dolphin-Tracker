"""Device sync rules: what one report day does to a project's stores. Pure.

- A screen whose DD code is in the report gets the report's values (`Screen.device`); its work status follows the
  report: Online → Completed, Offline → Offline, Not Registered → Not Registered. A device with no first and no
  latest registered date never registered, so (unless it is Online) it is Not Registered whatever else the report
  says. Archived → Archived when it ever registered (it ran for a while), Cancelled when it never did.
  A screen the tracker has Cancelled or Archived only moves between those two. Testing and Unclassified only show.
- The store gets the report's name, address and location from its first matched screen (`Stop.device`), shown
  over the sheet values. Nothing overwrites the sheet values except an explicit Overwrite.
- A Completed screen with a DD code the report lacks flags the store "not in Dolphin data", unless it became
  Completed after the report was loaded, or someone ignored the alert for this report day.
- A store with no DMA takes the report's (from any matched screen); a DMA already set is never replaced. The venue
  type works the same way, from the report's OOH category.
- Report records whose DD code no screen has are listed for review (Archived ones are not).
"""
from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from dolphin_tracker.domain.device import (
    DeviceRecord,
    DeviceSnapshot,
    ReviewItem,
    ScreenDevice,
    StoreDevice,
    split_codes,
    venue_code_key,
)
from dolphin_tracker.domain.import_mapping import dedupe_key_address
from dolphin_tracker.domain.models import NeedsAttention, Screen, ScreenStatus, Stop, derive_store_status
from dolphin_tracker.domain.validation import normalize_external_id

# Closed in the tracker: the report only says which of the two it is (did the device ever register).
KEEP_STATUSES = frozenset({ScreenStatus.CANCELLED, ScreenStatus.ARCHIVED})
NOT_REVIEWED = frozenset({"archived"})
OVERWRITABLE = ("store_name", "addr", "city", "state", "zip", "location")


def device_status(record: DeviceRecord) -> ScreenStatus | None:
    """The work status one report record stands for; None when the report does not decide it."""
    status = record.status.strip().lower()
    if status == "online":  # reporting now, whatever the registered dates say
        return ScreenStatus.COMPLETED
    if status == "archived":
        return ScreenStatus.ARCHIVED if record.registered else ScreenStatus.CANCELLED
    if status == "not registered" or not record.registered:
        return ScreenStatus.NOT_REGISTERED
    return ScreenStatus.OFFLINE if status == "offline" else None


def index_records(records: Iterable[DeviceRecord]) -> dict[str, DeviceRecord]:
    """Records by venue_code_key; a repeated code keeps the first (the report has one row per venue per day)."""
    indexed: dict[str, DeviceRecord] = {}
    for record in records:
        key = venue_code_key(record.venue_id)
        if key and key not in indexed:
            indexed[key] = record
    return indexed


def screen_device(record: DeviceRecord) -> ScreenDevice:
    return ScreenDevice(
        status=record.status, last_seen=record.last_seen, offline_days=record.offline_days,
        serial_number=record.serial_number, venue_name=record.venue_name, date=record.date,
        first_registered=record.first_registered, last_registered=record.last_registered,
    )


def store_device(record: DeviceRecord) -> StoreDevice:
    return StoreDevice(
        store_name=record.store_name, venue_name=record.venue_name, address=record.address, addr=record.addr,
        city=record.city, state=record.state, zip=record.zip, lat=record.lat, lng=record.lng, dma=record.dma,
        venue_type=record.venue_type, date=record.date,
    )


def sync_screen(screen: Screen, record: DeviceRecord | None, now: str) -> Screen:
    if record is None:
        return screen.model_copy(update={"device": None})
    update: dict[str, Any] = {"device": screen_device(record)}
    target = device_status(record)
    closed = screen.status in KEEP_STATUSES and target not in KEEP_STATUSES
    if target is not None and not closed and target != screen.status:
        update.update(status=target, status_changed_at=now)
    return screen.model_copy(update=update)


def not_reporting(screens: Iterable[Screen], codes: dict[str, DeviceRecord], snapshot: DeviceSnapshot) -> bool:
    """A Completed screen with a DD code the report lacks, Completed before the report was loaded."""
    for screen in screens:
        key = venue_code_key(screen.venue_id)
        if screen.status != ScreenStatus.COMPLETED or not key or key in codes or len(split_codes(screen.venue_id)) > 1:
            continue  # a packed entry is flagged for review instead
        if not screen.status_changed_at or not snapshot.ingested_at or screen.status_changed_at < snapshot.ingested_at:
            return True
    return False


def packed_screens(screens: Iterable[Screen]) -> list[Screen]:
    """Screens whose DD code entry holds several codes ("DD-HJGK7Z. DD-HB8P6I"): not parsed, so never matched;
    the store asks for a manual fix instead (with the split as a suggestion)."""
    return [screen for screen in screens if len(split_codes(screen.venue_id)) > 1]


def sync_stop(stop: Stop, codes: dict[str, DeviceRecord], snapshot: DeviceSnapshot, now: str) -> dict[str, Any]:
    """The DEVICE_FIELDS write that brings one store in line with the report; {} when nothing changes."""
    screens = [sync_screen(screen, codes.get(venue_code_key(screen.venue_id)), now) for screen in stop.screens]
    first = next((codes[key] for screen in stop.screens if (key := venue_code_key(screen.venue_id)) in codes), None)
    device = store_device(first) if first else None
    synced_reasons = (NeedsAttention.NOT_REPORTING, NeedsAttention.DD_CODE_REVIEW)
    reasons = [reason for reason in stop.needs_attention if reason not in synced_reasons]
    if stop.device_alert_ignored != snapshot.date and not_reporting(screens, codes, snapshot):
        reasons.append(NeedsAttention.NOT_REPORTING)
    if packed_screens(screens):
        reasons.append(NeedsAttention.DD_CODE_REVIEW)

    changes: dict[str, Any] = {}
    if screens != stop.screens:
        changes["screens"] = [screen.model_dump(mode="json") for screen in screens]
        changes["status"] = derive_store_status(screens).value
    if device != stop.device:
        changes["device"] = device.model_dump(mode="json") if device else None
    if reasons != list(stop.needs_attention):
        changes["needs_attention"] = [str(reason) for reason in reasons]
    dma = next((codes[key].dma for screen in stop.screens
                if (key := venue_code_key(screen.venue_id)) in codes and codes[key].dma), "")
    if dma and not stop.dma.strip():
        changes["dma"] = dma  # fills a blank DMA only: a value from the sheet or a person always wins
    venue_type = next((codes[key].venue_type for screen in stop.screens
                       if (key := venue_code_key(screen.venue_id)) in codes and codes[key].venue_type), "")
    if venue_type and not stop.venue_type.strip():
        changes["venue_type"] = venue_type  # the same: only a blank venue type is filled
    return changes


def review_items(
    records: Iterable[DeviceRecord], stops: Iterable[Stop], snoozed: dict[str, str], date: str
) -> list[ReviewItem]:
    """Report records whose DD code no screen of the project has. `snoozed` (key → report day) carries "Not now"
    over a re-sync of the same day; a newer day shows them again."""
    known = {venue_code_key(code) for stop in stops for screen in stop.screens for code in split_codes(screen.venue_id)}
    items = []
    for key, record in index_records(records).items():
        if key in known or record.status.strip().lower() in NOT_REVIEWED:
            continue
        snoozed_date = date if snoozed.get(key) == date else ""
        items.append(ReviewItem(**record.model_dump(), key=key, snoozed_date=snoozed_date))
    items.sort(key=lambda item: (item.store_name.lower() or "~", item.key))
    return items


def overwrite_changes(stop: Stop, fields: Iterable[str]) -> dict[str, Any]:
    """Copy report values into the store's own fields. Only values the report has; `location` is lat/lng (and the
    report's address as the verified one), which also marks the routes stale and clears the address alert."""
    device = stop.device
    if device is None:
        return {}
    changes: dict[str, Any] = {}
    for name in fields:
        if name == "location":
            if device.lat is not None and device.lng is not None and (device.lat, device.lng) != (stop.lat, stop.lng):
                changes.update(lat=device.lat, lng=device.lng, route_stale=True)
                if device.address:
                    changes["geocoded"] = device.address
                # From what an earlier field already cleared (store_name), not from the stored list again.
                current = changes.get("needs_attention", [str(reason) for reason in stop.needs_attention])
                reasons = [reason for reason in current if reason != NeedsAttention.ADDRESS.value]
                if reasons != current:
                    changes["needs_attention"] = reasons
        elif name in OVERWRITABLE:
            value = getattr(device, name)
            if value and value != getattr(stop, name):
                changes[name] = value
                if name == "store_name" and NeedsAttention.STORE_NAME in stop.needs_attention:
                    reasons = changes.get("needs_attention", [str(r) for r in stop.needs_attention])
                    changes["needs_attention"] = [r for r in reasons if r != NeedsAttention.STORE_NAME.value]
        else:
            raise ValueError(f"Cannot overwrite {name!r}; choose from {', '.join(OVERWRITABLE)}")
    return changes


def shown_location(stop: Stop) -> tuple[float | None, float | None]:
    """Where the map puts the store: the report's location when it has one, else the sheet's."""
    if stop.device and stop.device.lat is not None and stop.device.lng is not None:
        return stop.device.lat, stop.device.lng
    return stop.lat, stop.lng


def store_with_code(code: object, stops: Iterable[Stop], *, exclude_uid: str = "") -> Stop | None:
    """The store that already has this DD code on a screen (alone or inside a packed entry), if any. A DD code is
    one device, so it belongs to one store of the project."""
    key = venue_code_key(code)
    if not key:
        return None
    for stop in stops:
        if stop.uid == exclude_uid:
            continue
        if any(venue_code_key(part) == key for screen in stop.screens for part in split_codes(screen.venue_id)):
            return stop
    return None


def store_for_record(record: DeviceRecord, stops: Iterable[Stop]) -> Stop | None:
    """The store a report record's stick belongs to, when the project has it: same IBC# (the CMS's external id),
    else the same normalised address as the store's sheet address or its Dolphin data address. The record's own
    DD code is in no store (that is why it is under review), so it never decides this."""
    stops = list(stops)
    external_id = normalize_external_id(record.external_id)
    if external_id:
        found = next((stop for stop in stops if normalize_external_id(stop.external_id) == external_id), None)
        if found:
            return found
    wanted = dedupe_key_address({"addr": record.addr, "city": record.city, "state": record.state, "zip": record.zip})
    if not wanted:
        return None
    for stop in stops:
        keys = {dedupe_key_address({"addr": stop.addr, "city": stop.city, "state": stop.state, "zip": stop.zip})}
        if stop.device:
            device = stop.device
            keys.add(dedupe_key_address({"addr": device.addr, "city": device.city, "state": device.state,
                                         "zip": device.zip}))
        if wanted in keys:
            return stop
    return None


def add_record_changes(stop: Stop, record: DeviceRecord, snapshot: DeviceSnapshot, now: str) -> dict[str, Any]:
    """Apply one report record to the screen with its DD code only; the store's other screens keep what the last
    sync gave them. The store takes the record's values when it has no Dolphin data yet."""
    key = venue_code_key(record.venue_id)
    screens = [
        sync_screen(screen, record, now) if venue_code_key(screen.venue_id) == key else screen
        for screen in stop.screens
    ]
    changes: dict[str, Any] = {}
    if screens != stop.screens:
        changes["screens"] = [screen.model_dump(mode="json") for screen in screens]
        changes["status"] = derive_store_status(screens).value
    if stop.device is None:
        changes["device"] = store_device(record).model_dump(mode="json")
    return changes
