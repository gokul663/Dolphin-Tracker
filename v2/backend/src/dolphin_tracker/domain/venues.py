"""Every venue of the CMS data, kept outside the projects for the Route Planner.

A project shows only its own stores. The planner also offers every other venue the device report has (any PA), so
one trip can take in stores of other projects and venues nobody has put in a project: an Offline screen down the
road, say. Those venues live as stores under one reserved project id, `VENUES_PROJECT_ID`. It is not a project
anyone sees: it is never listed, has no settings, counts or costs; it only gives a venue a place to be routed from
and to have visits logged against. Pure.
"""
from __future__ import annotations

import re

from dolphin_tracker.domain.device import DeviceRecord, venue_code_key
from dolphin_tracker.domain.models import Project, ProjectType, Screen, ScreenStatus, Stop

VENUES_PROJECT_ID = "venues"
VENUES_PROJECT_NAME = "Not in a project"
# A venue the report closes (archived, or cancelled before it ever registered) is not offered for a route.
CLOSED = frozenset({ScreenStatus.ARCHIVED, ScreenStatus.CANCELLED})
# What a refresh brings up to date on a venue already kept; everything else on it (its plan, its visits) stays.
SYNCED_FIELDS = (
    "display_id", "store_name", "addr", "city", "state", "zip", "lat", "lng", "geocoded", "pa", "dma", "venue_type",
)


def venues_project() -> Project:
    return Project(id=VENUES_PROJECT_ID, name=VENUES_PROJECT_NAME, project_type=ProjectType.OFFLINE)


# The report's own word for a venue, as a work status. (A project's screen is read more carefully, from its
# registration dates too; a venue in no project is simply what the report says it is.)
REPORT_STATUS = {
    "online": ScreenStatus.COMPLETED, "offline": ScreenStatus.OFFLINE, "not registered": ScreenStatus.NOT_REGISTERED,
    "archived": ScreenStatus.ARCHIVED,
}


def venue_uid(venue_id: object) -> str:
    """The store uid of a venue: stable, from its DD code (`DD-ABC123` → `v-DD_ABC123`)."""
    return "v-" + re.sub(r"[^A-Z0-9_]", "", venue_code_key(venue_id))


def venue_stop(record: DeviceRecord) -> Stop | None:
    """The store that stands for one report record: one screen carrying the venue's DD code, its work status read
    from the report (Online → Completed, Offline, Not Registered, Archived). None when the report does not say
    (a test device) or the record has no code."""
    status = REPORT_STATUS.get(record.status.strip().lower())
    if status is None or not venue_code_key(record.venue_id):
        return None
    uid = venue_uid(record.venue_id)
    located = record.lat is not None and record.lng is not None
    return Stop(
        uid=uid,
        # The CMS's ExtID, shown only: `external_id` must be unique within a project, and across every PA it is not.
        display_id=record.external_id,
        store_name=record.store_name or record.venue_name or record.venue_id,
        addr=record.addr or record.address,
        city=record.city, state=record.state, zip=record.zip,
        lat=record.lat if located else None, lng=record.lng if located else None,
        geocoded=record.address if located else "",
        pa=record.pa_name, dma=record.dma, venue_type=record.venue_type,
        screens=[Screen(id=f"{uid}-s1", venue_id=record.venue_id, stick_number=record.serial_number, status=status,
                        cms_name=record.venue_name, venue_type=record.venue_type)],
        updated_by="CMS data",
    )


def refreshed(old: Stop, new: Stop) -> Stop | None:
    """`old` brought up to date with the report's `new`; None when nothing differs. The venue keeps its plan, its
    visits and its screen's id; only what the report knows is taken."""
    changes = {name: getattr(new, name) for name in SYNCED_FIELDS if getattr(old, name) != getattr(new, name)}
    screen, fresh = old.screens[0], new.screens[0]
    update = {name: getattr(fresh, name) for name in ("venue_id", "stick_number", "status", "cms_name", "venue_type")
              if getattr(screen, name) != getattr(fresh, name)}
    if update:
        changes["screens"] = [screen.model_copy(update=update), *old.screens[1:]]
    if not changes:
        return None
    return Stop.model_validate({**old.model_dump(), **{k: v for k, v in changes.items() if k != "screens"},
                                "screens": [s.model_dump() for s in changes.get("screens", old.screens)],
                                "updated_by": "CMS data"})
