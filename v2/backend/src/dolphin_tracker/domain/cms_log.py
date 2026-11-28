"""A Tracker log entry as a document of the shared log collection (MongoDB `dolphin_venue_vision.logs`). Pure.

The collection also holds the entries of the older logging system; both write to it while work moves to Tracker.
A Tracker entry keeps that system's fields and spellings (every value is text; yes/no checks are "yes"/"no";
the network type is lower case), so whatever reads the collection reads both alike, and adds a few of its own:

- `source`: "dolphin-tracker", so the two systems' entries can be told apart;
- `logged_by`: the signed-in person who saved it (the older entries only name the technician and the manager);
- `tracker_id`: the entry's id in Tracker, which also stops the same entry being written twice;
- `entry_type`: "screen" (a visit to one screen) or "store" (a comment on the store as a whole, no DD code);
- `subcategory`, `outcome` ("done" / "incomplete" / ""), `dagent_installed`, `replaced_with`.

`category` holds Tracker's category and `subcategory` its subcategory, as they were picked.
"""
from __future__ import annotations

import uuid

from dolphin_tracker.domain.device import venue_code_key
from dolphin_tracker.domain.models import Project, Stop
from dolphin_tracker.domain.visits import StoreComment, Visit

SOURCE = "dolphin-tracker"
STORE_COMMENT_CATEGORY = "Store Comment"

CmsLog = dict[str, str]


def _yes_no(value: bool) -> str:
    return "yes" if value else "no"


def _base(*, tracker_id: str, entry_type: str, logged_by: str, created_at: str) -> CmsLog:
    return {
        "id": str(uuid.UUID(tracker_id)) if _is_hex_uuid(tracker_id) else tracker_id,  # dashed, like the others
        "source": SOURCE,
        "tracker_id": tracker_id,
        "entry_type": entry_type,
        "logged_by": logged_by,
        "created_at": created_at,
    }


def _is_hex_uuid(value: str) -> bool:
    try:
        return uuid.UUID(value).hex == value
    except ValueError:
        return False


def visit_log(visit: Visit) -> CmsLog:
    """One screen's visit. The store's details are the snapshot the visit took when it was saved."""
    comments = visit.comments
    if visit.replaced_with:
        comments = f"{comments}\nReplaced with: {visit.replaced_with}".strip()
    return {
        **_base(tracker_id=visit.id, entry_type="screen", logged_by=visit.logged_by, created_at=visit.created_at),
        "date": visit.visit_date,
        "dd_code": venue_code_key(visit.dd_code),  # DD_ABC123, the collection's spelling
        "venue_name": visit.venue_name,
        "store_name": visit.store_name,
        "address": visit.addr,
        "pa": visit.pa,
        "fa": visit.fa,
        "installer": visit.installer,
        "dolphin_manager": visit.dolphin_manager,
        "stick_number": visit.stick_number,
        "stick_model": "",
        "category": visit.category,
        "subcategory": visit.subcategory,
        "detailed_comments": comments,
        "replaced_with": visit.replaced_with,
        "outcome": visit.outcome,
        "network_type": str(visit.network_type).lower(),
        "latest_apk": _yes_no(visit.latest_apk),
        "kiosk_mode": _yes_no(visit.kiosk_mode),
        "dagent_installed": _yes_no(visit.dagent_installed),
        "wifi_autoconnect": "",  # Tracker does not ask
        "wifi_name": visit.wifi_ssid,
        "wifi_password": visit.wifi_password,
        "owner_name": visit.owner_name,
        "owner_email": visit.owner_email,
        "contact_number": visit.owner_phone or visit.store_contact_phone,
    }


def comment_log(comment: StoreComment, stop: Stop, project: Project) -> CmsLog:
    """A comment on the store as a whole: no screen, so no DD code, stick or checks."""
    return {
        **_base(tracker_id=comment.id, entry_type="store", logged_by=comment.created_by, created_at=comment.created_at),
        "date": comment.visit_date,
        "dd_code": "",
        "venue_name": "",
        "store_name": stop.store_name,
        "address": ", ".join(part for part in (stop.addr, stop.city, stop.state, stop.zip) if part),
        "pa": stop.pa or project.pa,
        "fa": project.field_agent,
        "installer": comment.installer,
        "dolphin_manager": comment.dolphin_manager,
        "stick_number": "",
        "stick_model": "",
        "category": STORE_COMMENT_CATEGORY,
        "subcategory": "",
        "detailed_comments": comment.text,
        "replaced_with": "",
        "outcome": "",
        "network_type": "",
        "latest_apk": "",
        "kiosk_mode": "",
        "dagent_installed": "",
        "wifi_autoconnect": "",
        "wifi_name": "",
        "wifi_password": "",
        "owner_name": stop.owner_name,
        "owner_email": stop.owner_email,
        "contact_number": stop.owner_phone or stop.onsite_contact_phone,
    }
