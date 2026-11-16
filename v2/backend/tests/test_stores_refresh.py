"""Stores UI refresh (docs/STORES-UI-REFRESH.md): status groups, install type, needs mount, fulfilled, DMA sync."""
import unittest

from dolphin_tracker.domain.device import DeviceRecord, DeviceSnapshot
from dolphin_tracker.domain.device_sync import index_records, sync_stop
from dolphin_tracker.domain.import_mapping import detect_mapping, map_row
from dolphin_tracker.domain.kpi import kpi_summary
from dolphin_tracker.domain.models import Screen, ScreenInput, ScreenStatus, Stop
from dolphin_tracker.domain.statuses import (
    BUCKET_OF,
    StatusBucket,
    install_type_from_sheet,
    normalize_screen_status,
)
from dolphin_tracker.services.stores import fulfillment
from tests.fakes import report_row
from tests.test_stores_api import StoresApiTestCase


def stop(uid: str, *statuses: str, **extra) -> Stop:
    return Stop(uid=uid, display_id=uid.upper(), store_name=uid, addr="1 Main St", lat=33.7, lng=-84.4,
                screens=[Screen(status=status, venue_id=f"DD_{uid.upper()}{i}") for i, status in enumerate(statuses)],
                **extra)


class BucketTests(unittest.TestCase):
    def test_every_status_has_a_group(self):
        self.assertEqual(set(BUCKET_OF), set(ScreenStatus))
        self.assertEqual(BUCKET_OF[ScreenStatus.ARCHIVED], StatusBucket.CANCELLED)
        for status in ("Invitation Email Sent", "Shipped", "Delivered", "Serviced - Needs More Work"):
            self.assertEqual(BUCKET_OF[ScreenStatus(status)], StatusBucket.IN_PROGRESS)

    def test_cancelled_location_is_cancelled(self):
        self.assertEqual(normalize_screen_status("Cancelled Location"), (ScreenStatus.CANCELLED, True))

    def test_kpi_groups_and_technicians(self):
        kpi = kpi_summary([
            stop("a", "Completed", "Completed", installer_name="Murugan").model_dump(mode="json"),
            stop("b", "Upcoming", "Shipped", installer_name="Murugan").model_dump(mode="json"),
            stop("c", "Archived").model_dump(mode="json"),
            stop("d", "Offline", install_type="Rep install").model_dump(mode="json"),
        ])
        self.assertEqual(kpi.by_bucket, {"Completed": 1, "Upcoming": 1, "In Progress": 0, "Offline": 1,
                                         "Cancelled": 1})
        self.assertEqual(kpi.screens_by_bucket["Completed"], 2)
        self.assertEqual(kpi.screens_by_bucket["In Progress"], 1)
        self.assertEqual(kpi.by_technician["Murugan"].model_dump(), {"done": 2, "upcoming": 2})
        self.assertEqual(kpi.install_types, {"Technician": 2, "": 1, "Rep install": 1})  # a name implies Technician
        # Completed in the header = installed: online (Completed) and Offline screens together.
        self.assertEqual((kpi.installed_screens, kpi.installed_stores), (3, 2))  # a: 2 Completed; d: Offline
        self.assertEqual(kpi.committed_stores, 0)


class InstallTypeTests(unittest.TestCase):
    def test_sheet_status_to_install_type(self):
        self.assertEqual(install_type_from_sheet("Technician"), "Technician")
        for value in ("completed", "Archived", "cancelled location", "offline", "", None):
            self.assertEqual(install_type_from_sheet(value), "", value)
        for value in ("on hold", "Shipped", "invitation email sent", "upcoming"):
            self.assertEqual(install_type_from_sheet(value), "Self install", value)

    def test_import_row_keeps_status_upcoming_and_sets_install_type(self):
        columns = ["ibc", "store_name", "address", "status", "technician_name"]
        mapping = detect_mapping(columns)
        self.assertEqual(mapping["technician_name"], "installer_name")
        technician = map_row(0, {"ibc": "X1", "store_name": "A", "address": "1 Main St", "status": "technician",
                                 "technician_name": "Abubaker"}, mapping)
        self.assertEqual((technician.status, technician.status_valid), (ScreenStatus.UPCOMING, True))
        self.assertEqual((technician.details["install_type"], technician.installer_name), ("Technician", "Abubaker"))
        self_install = map_row(1, {"ibc": "X2", "store_name": "B", "address": "2 Main St", "status": "Waiting"},
                               mapping)
        self.assertEqual((self_install.status, self_install.status_valid), (ScreenStatus.UPCOMING, True))
        self.assertEqual(self_install.details["install_type"], "Self install")
        done = map_row(2, {"ibc": "X3", "store_name": "C", "address": "3 Main St", "status": "completed"}, mapping)
        self.assertEqual(done.status, ScreenStatus.COMPLETED)
        self.assertNotIn("install_type", done.details)


class FulfilledTests(unittest.TestCase):
    def test_completed_screens_against_committed(self):
        self.assertEqual(fulfillment(stop("a", "Completed")), "No commitment")
        self.assertEqual(fulfillment(stop("a", "Completed", committed_dolphin_screens=1, committed_store_tvs=1)),
                         "Not fulfilled")
        self.assertEqual(fulfillment(stop("a", "Completed", "Completed", "Upcoming", committed_dolphin_screens=1,
                                          committed_store_tvs=1)), "Fulfilled")
        self.assertEqual(fulfillment(stop("a", "Upcoming", "Shipped", committed_dolphin_screens=2)), "Not fulfilled")
        # Offline and Needs More Work screens are on the wall: installed.
        self.assertEqual(fulfillment(stop("a", "Offline", committed_dolphin_screens=1)), "Fulfilled")
        self.assertEqual(fulfillment(stop("a", "Serviced - Needs More Work", "Completed", committed_dolphin_screens=2)),
                         "Fulfilled")
        self.assertEqual(fulfillment(stop("a", "Delivered", "Cancelled", committed_dolphin_screens=1)), "Not fulfilled")


class DmaSyncTests(unittest.TestCase):
    def sync(self, store: Stop, dma: str = "Atlanta") -> dict:
        record = DeviceRecord.from_report(report_row(store.screens[0].venue_id, DMA=dma))
        snap = DeviceSnapshot(pa="IBC", date=record.date, ingested_at="2026-11-10T00:00:00+00:00", records=[record])
        return sync_stop(store, index_records(snap.records), snap, "2026-11-10T01:00:00+00:00")

    def test_report_dma_is_read(self):
        self.assertEqual(DeviceRecord.from_report(report_row("DD_X", DMA=" Atlanta ")).dma, "Atlanta")

    def test_fills_a_blank_dma(self):
        changes = self.sync(stop("a", "Upcoming"))
        self.assertEqual(changes["dma"], "Atlanta")
        self.assertEqual(changes["device"]["dma"], "Atlanta")

    def test_never_overwrites_a_dma(self):
        self.assertNotIn("dma", self.sync(stop("a", "Upcoming", dma="ATL Metro")))

    def test_report_without_dma_changes_nothing(self):
        self.assertNotIn("dma", self.sync(stop("a", "Upcoming"), dma=""))


class NeedsMountTests(unittest.TestCase):
    def test_defaults_false_and_round_trips(self):
        self.assertFalse(Screen().needs_mount)
        screen = ScreenInput(needs_mount=True, has_mount=False).to_screen()
        self.assertTrue(screen.needs_mount)


class RefreshApiTests(StoresApiTestCase):
    def test_new_facets_and_filters(self):
        options = self.get("/filters").json()
        self.assertEqual({o["value"] for o in options["bucket"]}, {"Completed", "Upcoming", "Offline"})
        self.assertEqual(self.uids(bucket="Offline"), ["c"])
        self.assertEqual(sorted(self.uids(bucket=["Completed", "Offline"])), ["a", "c"])
        self.assertEqual(self.uids(fulfilled="Not fulfilled"), ["a"])  # 1 of 2 committed screens done
        self.assertEqual(self.uids(mount="Needs mount"), [])

    def test_install_type_edit_and_needs_mount(self):
        response = self.client.patch("/api/projects/p1/stores/a", json={"install_type": "Rep install"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.uids(install_type="Rep install"), ["a"])
        bad = self.client.patch("/api/projects/p1/stores/a", json={"install_type": "Drone"})
        self.assertEqual(bad.status_code, 422, bad.text)
        screens = self.get("/a").json()["screens"]
        screens[0]["needs_mount"] = True
        put = self.client.put("/api/projects/p1/stores/a/screens",
                              json={"screens": [{k: v for k, v in s.items() if k not in ("device", "status_changed_at")}
                                                for s in screens]})
        self.assertEqual(put.status_code, 200, put.text)
        self.assertEqual(self.uids(mount="Needs mount"), ["a"])

    def test_technician_filter_and_self_install(self):
        for uid, name in (("a", "Sai"), ("b", "unsure"), ("c", "self install")):
            response = self.client.patch(f"/api/projects/p1/stores/{uid}/progress", json={"installer_name": name})
            self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.uids(technician="Sai"), ["a"])
        self.assertEqual(sorted(self.uids(technician="")), ["b", "c", "d"])  # "unsure" and "self install" are nobody
        self.assertEqual(self.get("/c").json()["install_type"], "Self install")
        self.assertEqual(self.get("/a").json()["install_type"], "Technician")
        options = {o["value"]: o["count"] for o in self.get("/filters").json()["technician"]}
        self.assertEqual(options, {"Sai": 1, "": 3})


if __name__ == "__main__":
    unittest.main()


# --- Technician column values (assignment) ------------------------------------------------------------------------

import pytest  # noqa: E402

from dolphin_tracker.domain.statuses import store_assignment  # noqa: E402


@pytest.mark.parametrize(
    ("name", "install_type", "expected"),
    [
        ("Sai", "", ("Sai", "Technician")),
        ("unsure", "", ("", "")),
        ("OTHER", "", ("", "")),
        ("self install", "", ("", "Self install")),
        ("REP install", "", ("", "Rep install")),
        ("Sai", "Self install", ("", "Self install")),  # a self install has no technician
        ("Sai", "Rep install", ("", "Rep install")),  # nor does a rep install
        ("", "", ("", "")),
    ],
)
def test_store_assignment(name: str, install_type: str, expected: tuple[str, str]) -> None:
    assert store_assignment(name, install_type) == expected


class MountCountTests(StoresApiTestCase):
    def test_mount_counts_round_trip(self):
        body = {"wall_mounts_needed": 2, "ceiling_mounts_needed": 1, "tv_mounts_needed": 3}
        response = self.client.patch("/api/projects/p1/stores/a", json=body)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual({key: response.json()[key] for key in body}, body)
        self.assertEqual(self.client.patch("/api/projects/p1/stores/a", json={"tv_mounts_needed": -1}).status_code, 422)
        cleared = self.client.patch("/api/projects/p1/stores/a", json={"tv_mounts_needed": None}).json()
        self.assertIsNone(cleared["tv_mounts_needed"])
        self.assertEqual(self.uids(mount="Needs mount"), ["a"])  # wall and ceiling mounts are still to bring


# --- One row per DD code -------------------------------------------------------------------------------------------

from dolphin_tracker.domain.models import ScreenDevice, merge_same_code  # noqa: E402


def test_rows_sharing_a_dd_code_merge_into_the_first() -> None:
    sheet = Screen(id="s1", venue_id="DD-H5036X", stick_number="DD-002-03888", screen_size='43"', has_mount=True,
                   is_dolphin_screen=False)  # a store TV keeps its own size
    added = Screen(id="s2", venue_id="DD_H5036X", status=ScreenStatus.OFFLINE, is_dolphin_screen=False,
                   device=ScreenDevice(status="Offline", date="11-15", serial_number="DD-002-03888"))
    other = Screen(id="s3", venue_id="DD-OTHER1")
    merged = merge_same_code([sheet, other, added])
    assert [screen.id for screen in merged] == ["s1", "s3"]  # where the first stood; the duplicate is gone
    assert merged[0].venue_id == "DD-H5036X" and merged[0].stick_number == "DD-002-03888"
    assert merged[0].screen_size == '43"' and merged[0].has_mount
    assert merged[0].status == ScreenStatus.OFFLINE  # the duplicate knew more than Upcoming
    assert merged[0].device is not None and merged[0].device.status == "Offline"


def test_rows_without_a_code_or_with_several_are_left_alone() -> None:
    rows = [Screen(id="a", venue_id=""), Screen(id="b", venue_id=""), Screen(id="c", venue_id="DD-A1. DD-B2"),
            Screen(id="d", venue_id="DD-A1. DD-B2")]
    assert [screen.id for screen in merge_same_code(rows)] == ["a", "b", "c", "d"]


def test_a_store_never_shows_one_code_twice() -> None:
    store = Stop(uid="x", store_name="LA22 Mart", addr="1 Main",
                 screens=[Screen(venue_id="DD-HIYWYB", stick_number="DD-002-02155"), Screen(venue_id="DD_HIYWYB")])
    assert [(screen.venue_id, screen.stick_number) for screen in store.screens] == [("DD-HIYWYB", "DD-002-02155")]


def test_a_dolphin_screen_is_always_24_inches() -> None:
    assert Screen(is_dolphin_screen=True).screen_size == '24"'
    assert Screen(is_dolphin_screen=True, screen_size='55"').screen_size == '24"'
    assert Screen(is_dolphin_screen=False, screen_size='55"').screen_size == '55"'  # a store TV keeps its own
    assert ScreenInput(is_dolphin_screen=True).to_screen().screen_size == '24"'


# --- Venue type from the Dolphin data's OOH category -----------------------------------------------------------------

from dolphin_tracker.domain.device import venue_type_label  # noqa: E402


@pytest.mark.parametrize(
    ("category", "label"),
    [
        ("retail.convenience_store", "Convenience Store"),
        ("retail.gas_stations.shop", "Gas Stations"),
        ("retail", "Retail"),
        ("entertainment.casual_dining", "Casual Dining"),
        ("", ""),
        (None, ""),
    ],
)
def test_venue_type_label(category: str | None, label: str) -> None:
    assert venue_type_label(category) == label


class VenueTypeSyncTests(unittest.TestCase):
    def sync(self, store: Stop) -> dict:
        row = report_row(store.screens[0].venue_id, **{"OOH Category": "retail.convenience_store"})
        record = DeviceRecord.from_report(row)
        snap = DeviceSnapshot(pa="IBC", date=record.date, ingested_at="2026-11-10T00:00:00+00:00", records=[record])
        return sync_stop(store, index_records(snap.records), snap, "2026-11-10T01:00:00+00:00")

    def test_fills_a_blank_venue_type(self):
        self.assertEqual(self.sync(stop("a", "Upcoming")).get("venue_type"), "Convenience Store")

    def test_never_overwrites_a_venue_type(self):
        self.assertNotIn("venue_type", self.sync(stop("a", "Upcoming", venue_type="Bar")))
