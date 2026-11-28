"""Per-store numbers worked out from the screen rows: committed and installed screens, mounts needed and used, and
the committed-vs-actual screen mismatch. Pure. One function per number, so the store window, the table, the CSV
export, the filters and the KPIs all read the same rule.

Takes anything shaped like a Stop (or its screens), so `models.py` can expose these as computed fields."""
from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from dolphin_tracker.domain.kpi import ignore_holds, missing_screens
from dolphin_tracker.domain.statuses import INSTALLED_STATUSES, ScreenStatus, screen_size_label

MOUNT_KINDS = ("wall_24", "wall", "ceiling")
# A mount is still to bring and fit while its screen is not on the wall yet: the Upcoming group (except Serviced -
# Needs More Work, which is on the wall) and Not Registered (the CMS has the device, nothing reports yet).
MOUNT_NEEDED_STATUSES = frozenset({
    ScreenStatus.UPCOMING, ScreenStatus.INVITATION_EMAIL_SENT, ScreenStatus.SHIPPED, ScreenStatus.DELIVERED,
    ScreenStatus.NOT_REGISTERED,
})
# A mount is used once its screen is installed (Completed = online, Offline, Needs More Work): INSTALLED_STATUSES.


def mount_kind(screen: Any) -> str | None:
    """The piece a screen's mount is: the 24 inch wall mount, a wall mount of another size, or a ceiling mount; None
    when no mount is picked."""
    if not screen.has_mount:
        return None
    if screen.has_ceiling_mount:
        return "ceiling"
    return "wall_24" if (screen_size_label(screen.screen_size) or '24"') == '24"' else "wall"


def computed_mounts_needed(screens: Iterable[Any]) -> dict[str, int]:
    """Mounts to bring per piece, worked out from the screens: a mount picked and the screen not installed yet."""
    counts = dict.fromkeys(MOUNT_KINDS, 0)
    for screen in screens:
        kind = mount_kind(screen)
        if kind and screen.status in MOUNT_NEEDED_STATUSES:
            counts[kind] += 1
    return counts


def mounts_needed(stop: Any) -> dict[str, int]:
    """Mounts to bring per piece: always worked out from the screens (a number typed or imported earlier is not
    used any more)."""
    return computed_mounts_needed(stop.screens)


def mounts_needed_total(stop: Any) -> int:
    """All mounts to bring, every piece together."""
    return sum(mounts_needed(stop).values())


def computed_mounts_used(screens: Iterable[Any]) -> int:
    """Mounts on the wall, worked out from the screens: a mount picked and the screen installed."""
    return sum(1 for screen in screens if screen.has_mount and screen.status in INSTALLED_STATUSES)


def mounts_used(stop: Any) -> int:
    """Mounts used at the store: always worked out from the screens."""
    return computed_mounts_used(stop.screens)


def committed_screens(stop: Any) -> int:
    """What the sheet committed: Dolphin screens + store TVs, a blank count being 0."""
    return (stop.committed_dolphin_screens or 0) + (stop.committed_store_tvs or 0)


def installed_screens(stop: Any) -> int:
    """Screen rows on the wall (Completed, Offline, Serviced - Needs More Work), Dolphin screens and TVs alike."""
    return sum(1 for screen in stop.screens if screen.status in INSTALLED_STATUSES)


def screen_mismatch(stop: Any) -> bool:
    """A store that reads as done (Completed or Offline) with fewer screen rows than committed, ignored or not."""
    return missing_screens(stop.status, committed_screens(stop), len(stop.screens)) > 0


def mismatch_ignored(stop: Any) -> bool:
    """The store mismatches and its stored ignore was set for exactly its current numbers."""
    return screen_mismatch(stop) and ignore_holds(stop.mismatch_ignore, committed_screens(stop), len(stop.screens))
