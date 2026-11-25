"""Stores UI refresh (docs/STORES-UI-REFRESH.md): status groups, install type, needs mount, fulfilled, DMA sync."""
import unittest

from dolphin_tracker.domain.device import DeviceRecord, DeviceSnapshot
from dolphin_tracker.domain.device_sync import index_records, sync_stop
from dolphin_tracker.domain.import_mapping import detect_mapping, map_row
from dolphin_tracker.domain.kpi import kpi_summary
from dolphin_tracker.domain.models import HardwareCosts, Screen, ScreenInput, ScreenStatus, Stop
from dolphin_tracker.domain.statuses import (
    BUCKET_OF,
    StatusBucket,
    install_type_from_sheet,
    normalize_screen_status,
)
from dolphin_tracker.services.stores import facet_values, fulfillment
from tests.fakes import report_row
from tests.test_stores_api import StoresApiTestCase


def stop(uid: str, *statuses: str, **extra) -> Stop:
    return Stop(uid=uid, display_id=uid.upper(), store_name=uid, addr="1 Main St", lat=33.7, lng=-84.4,
                screens=[Screen(status=status, venue_id=f"DD_{uid.upper()}{i}") for i, status in enumerate(statuses)],
                **extra)


class BucketTests(unittest.TestCase):
    def test_every_status_has_a_group(self):
        self.assertEqual(set(BUCKET_OF), set(ScreenStatus))
        self.assertEqual(BUCKET_OF[ScreenStatus.ARCHIVED], StatusBucket.ARCHIVED)  # its own group, apart from Cancelled
        self.assertEqual(BUCKET_OF[ScreenStatus.NOT_REGISTERED], StatusBucket.NOT_REGISTERED)
        for status in ("Invitation Email Sent", "Shipped", "Delivered", "Serviced - Needs More Work"):
            self.assertEqual(BUCKET_OF[ScreenStatus(status)], StatusBucket.UPCOMING)  # no In Progress group for now

    def test_cancelled_location_is_cancelled(self):
        self.assertEqual(normalize_screen_status("Cancelled Location"), (ScreenStatus.CANCELLED, True))

    def test_kpi_groups_and_technicians(self):
        kpi = kpi_summary([
            stop("a", "Completed", "Completed", installer_name="Murugan").model_dump(mode="json"),
            stop("b", "Upcoming", "Shipped", installer_name="Murugan").model_dump(mode="json"),
            stop("c", "Archived").model_dump(mode="json"),
            stop("d", "Offline", install_type="Rep install").model_dump(mode="json"),
        ])
        self.assertEqual(kpi.by_bucket, {"Completed": 1, "Upcoming": 1, "Offline": 1, "In Progress": 0,
                                         "Cancelled": 0, "Archived": 1})
        # Not Registered is a screen's status: its store reads In Progress.
        waiting = kpi_summary([stop("e", "Not Registered", "Completed").model_dump(mode="json")])
        self.assertEqual((waiting.by_bucket["In Progress"], waiting.screens_by_bucket["Not Registered"]), (1, 1))
        self.assertNotIn("Not Registered", waiting.by_bucket)
        self.assertEqual(facet_values(stop("e", "Not Registered"), None, "bucket"), ["In Progress"])
        self.assertEqual(kpi.screens_by_bucket["Completed"], 2)
        self.assertEqual(kpi.screens_by_bucket["Upcoming"], 2)  # Upcoming and Shipped
        self.assertEqual(kpi.by_technician["Murugan"].model_dump(), {"done": 2, "upcoming": 2})
        self.assertEqual(kpi.install_types, {"Technician": 2, "": 1, "Rep install": 1})  # a name implies Technician
        # Completed in the header = installed: online (Completed) and Offline screens together.
        self.assertEqual((kpi.installed_screens, kpi.installed_stores), (3, 2))  # a: 2 Completed; d: Offline
        self.assertEqual(kpi.committed_stores, 4)  # every store counts, with or without a committed number
        self.assertEqual(kpi.installed_dolphin_by_model, {'24"|': 3})  # its installed Dolphin screens


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
        # A blank committed count is 0: anything installed meets it; nothing installed and no count says nothing.
        self.assertEqual(fulfillment(stop("a", "Completed")), "Fulfilled")
        self.assertEqual(fulfillment(stop("a", "Upcoming")), "No commitment")
        # Done (every row is on the wall) with fewer rows than committed: someone has to look.
        self.assertEqual(fulfillment(stop("a", "Completed", committed_dolphin_screens=1, committed_store_tvs=1)),
                         "Needs review")
        self.assertEqual(fulfillment(stop("a", "Offline", "Completed", committed_dolphin_screens=3)), "Needs review")
        kpi = kpi_summary([
            stop("a", "Completed", committed_dolphin_screens=3).model_dump(mode="json"),  # 2 missing
            stop("b", "Upcoming", committed_dolphin_screens=3).model_dump(mode="json"),  # not done: still to come
            stop("c", "Completed", "Completed").model_dump(mode="json"),  # no commitment
        ])
        self.assertEqual((kpi.review_stores, kpi.review_screens), (1, 2))
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

    def test_mounts_needed_are_worked_out_from_upcoming_screens_unless_typed(self):
        from dolphin_tracker.services.stores import mounts_needed, needs_mount
        screens = [Screen(has_mount=True), Screen(has_mount=True, screen_size="43"),
                   Screen(has_mount=True, has_ceiling_mount=True), Screen(has_mount=True, status="Completed"), Screen()]
        store = Stop(uid="a", store_name="A", addr="1 Main St", screens=screens)
        self.assertEqual(mounts_needed(store), {"wall_24": 1, "wall": 1, "ceiling": 1})  # the installed one is done
        self.assertTrue(needs_mount(store))
        typed = store.model_copy(
            update={"wall_24_mounts_needed": 3, "wall_mounts_needed": 0, "ceiling_mounts_needed": 0})
        self.assertEqual(mounts_needed(typed), {"wall_24": 3, "wall": 0, "ceiling": 0})  # a typed number wins, 0 too
        none = store.model_copy(update=dict.fromkeys(("wall_24_mounts_needed", "wall_mounts_needed",
                                                      "ceiling_mounts_needed"), 0))
        self.assertFalse(needs_mount(none))


class RefreshApiTests(StoresApiTestCase):
    def test_new_facets_and_filters(self):
        options = self.get("/filters").json()
        self.assertEqual({o["value"] for o in options["bucket"]}, {"Completed", "Upcoming", "Offline"})
        self.assertEqual(self.uids(bucket="Offline"), ["c"])
        self.assertEqual(sorted(self.uids(bucket=["Completed", "Offline"])), ["a", "c"])
        self.assertEqual(self.uids(fulfilled="Needs review"), ["a"])  # Completed with 1 row of 2 committed
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


def test_a_dolphin_screen_keeps_its_size() -> None:
    assert Screen(is_dolphin_screen=True).screen_size == '24"'  # the default
    assert Screen(is_dolphin_screen=True, screen_size="43in").screen_size == '43"'
    assert Screen(is_dolphin_screen=True, screen_size='50"').screen_size == '50"'
    assert Screen(is_dolphin_screen=True, screen_size='55"').screen_size == '55"'  # any size the price list has
    assert Screen(is_dolphin_screen=True, screen_size="big").screen_size == '24"'  # no inches: the default
    assert Screen(is_dolphin_screen=True, screen_type=" Dell ").screen_type == " Dell "
    assert Screen(is_dolphin_screen=False, screen_type="LG").screen_type == "LG"  # a store TV keeps its brand
    assert Screen(is_dolphin_screen=False, screen_size='55"').screen_size == '55"'  # a store TV keeps its own
    assert ScreenInput(is_dolphin_screen=True).to_screen().screen_size == '24"'


class HardwareCostTests(StoresApiTestCase):
    def test_prices_are_set_together_and_never_negative(self):
        prices = {"stick": 40, "screens": [{"size": '24"', "type": "Dolphin", "cost": 120},
                                           {"size": "24", "type": "Dell", "cost": 250.5},
                                           {"size": '43"', "type": "", "cost": None}]}
        response = self.client.patch("/api/projects/p1", json={"hardware_costs": prices})
        self.assertEqual(response.status_code, 200, response.text)
        saved = response.json()["hardware_costs"]
        self.assertEqual(saved["stick"], 40)
        self.assertEqual([(row["size"], row["type"], row["cost"]) for row in saved["screens"]],
                         [('24"', "Dolphin", 120), ('24"', "Dell", 120), ('43"', "", None)])  # one cost per size
        twice = {"stick": 40, "screens": [{"size": "24", "type": "Dell", "cost": 1},
                                          {"size": '24"', "type": "dell", "cost": 2}]}
        self.assertEqual(self.client.patch("/api/projects/p1", json={"hardware_costs": twice}).status_code, 422)
        # Prices saved per size before the list existed read as "Dolphin" rows.
        old = HardwareCosts.model_validate({"stick": 40, "screen_24": 120, "screen_43": None, "screen_50": 300})
        self.assertEqual([(row.size, row.type, row.cost) for row in old.screens],
                         [('24"', "Dolphin", 120), ('50"', "Dolphin", 300)])
        bad = self.client.patch("/api/projects/p1", json={"hardware_costs": {"stick": -1}})
        self.assertEqual(bad.status_code, 422, bad.text)
        self.assertEqual(self.client.patch("/api/projects/p1", json={"hardware_costs": None}).status_code, 422)


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


class HardwareCountTests(StoresApiTestCase):
    def test_counts_installed_hardware_under_the_filters(self):
        everything = self.client.get("/api/projects/p1/stores/hardware").json()
        # a: Completed Dolphin TV; c: Offline Dolphin TV → 2 sticks, two 24" TVs; b and d have nothing installed
        self.assertEqual(everything, {"installed_screens": 2, "installed_stores": 2,
                                      "installed_dolphin_by_model": {'24"|': 2},
                                      "mounts": {"wall_24": 0, "wall_other": 0, "ceiling": 0},
                                      "installed_mounts": {}})
        screens = [Screen(has_mount=True), Screen(has_mount=True, screen_size="43"),
                   Screen(has_mount=True, has_ceiling_mount=True), Screen(has_mount=True, status="Cancelled"), Screen()]
        self.stores.update_fields("p1", "b", {"screens": [screen.model_dump(mode="json") for screen in screens]})
        mounts = self.client.get("/api/projects/p1/stores/hardware").json()["mounts"]
        self.assertEqual(mounts, {"wall_24": 1, "wall_other": 1, "ceiling": 1})  # a cancelled screen's is not counted
        done = [Screen(has_mount=True, status="Completed"), Screen(has_mount=True, screen_size="43", status="Offline"),
                Screen(has_mount=True, has_ceiling_mount=True, screen_size="43", status="Completed"),
                Screen(has_mount=True)]  # upcoming: not bought yet
        self.stores.update_fields("p1", "b", {"screens": [screen.model_dump(mode="json") for screen in done]})
        counted = self.client.get("/api/projects/p1/stores/hardware").json()["installed_mounts"]
        self.assertEqual(counted, {'24"|wall': 1, '43"|wall': 1, '43"|ceiling': 1})

    def test_mount_prices_by_size(self):
        prices = {"stick": 40, "screens": [], "mounts": [{"size": "24", "wall": 15, "ceiling": None},
                                                         {"size": '43"', "wall": 30, "ceiling": 55.5}]}
        saved = self.client.patch("/api/projects/p1", json={"hardware_costs": prices}).json()["hardware_costs"]
        self.assertEqual(saved["mounts"], [{"size": '24"', "wall": 15, "ceiling": None},
                                           {"size": '43"', "wall": 30, "ceiling": 55.5}])
        twice = {"mounts": [{"size": "24", "wall": 1}, {"size": '24"', "ceiling": 2}]}
        self.assertEqual(self.client.patch("/api/projects/p1", json={"hardware_costs": twice}).status_code, 422)
        only_ga = self.client.get("/api/projects/p1/stores/hardware", params={"city": "Macon"}).json()
        self.assertEqual(only_ga["installed_screens"], 1)  # the filters apply (c is in Macon)


class TechnicianNameTests(StoresApiTestCase):
    def test_a_technician_is_one_name_whatever_the_case(self):
        for uid, name in (("a", "Carlos"), ("b", "carlos"), ("c", "Carlos")):
            self.stores.update_fields("p1", uid, {"installer_name": name, "install_type": "Technician"})
        options = self.client.get("/api/projects/p1/stores/filters").json()["technician"]
        self.assertIn({"value": "Carlos", "count": 3}, options)
        self.assertNotIn("carlos", [option["value"] for option in options])
        page = self.client.get("/api/projects/p1/stores", params={"technician": "CARLOS"}).json()
        self.assertEqual(sorted(item["uid"] for item in page["items"]), ["a", "b", "c"])
        kpi = self.client.get("/api/projects/p1").json()["kpi"]
        self.assertEqual(kpi["by_installer"].get("Carlos"), 3)
        self.assertNotIn("carlos", kpi["by_installer"])
        self.assertNotIn("carlos", kpi["by_technician"])


class InstallerWorkTests(StoresApiTestCase):
    def test_work_per_installer_and_syncing_names_to_the_list(self):
        from dolphin_tracker.repositories.memory import InMemoryListRepository
        from dolphin_tracker.services.lists import InstallerWorkService, ListService
        lists = InMemoryListRepository()
        ListService(lists).save_installer("Carlos", phone="5550102000")
        ListService(lists).save_installer("Nobody Yet", allow_no_phone=True)
        for uid, name in (("a", "carlos"), ("b", "Carlos"), ("c", "Zed"), ("d", "")):
            self.stores.update_fields("p1", uid, {"installer_name": name, "install_type": "Technician" if name else ""})
        service = InstallerWorkService(lists, self.projects, self.stores)
        report = service.report()
        carlos, nobody = report.installers
        self.assertEqual((carlos.name, carlos.stores, carlos.to_sync), ("Carlos", 2, 1))
        self.assertEqual(carlos.screens_done + carlos.screens_upcoming,
                         sum(len(self.stores.get("p1", uid).screens) for uid in ("a", "b")))
        self.assertEqual((nobody.name, nobody.stores), ("Nobody Yet", 0))
        self.assertEqual([(item.name, item.stores) for item in report.unlisted], [("Zed", 1)])  # kept, not matched
        self.assertEqual(service.sync_names().stores_updated, 1)
        self.assertEqual(self.stores.get("p1", "a").installer_name, "Carlos")
        self.assertEqual(self.stores.get("p1", "c").installer_name, "Zed")
        self.assertEqual(service.report().installers[0].to_sync, 0)
        self.assertEqual(service.sync_names().stores_updated, 0)

    def test_renaming_an_installer_keeps_the_id_and_carries_the_records(self):
        from dolphin_tracker.domain.errors import ValidationFailed
        from dolphin_tracker.domain.lists import NameListKind
        from dolphin_tracker.domain.route_plans import PlanDay, PlanInstaller, PlanStop, RoutePlan, StartLocation
        from dolphin_tracker.repositories.memory import InMemoryListRepository, InMemoryRoutePlanRepository
        from dolphin_tracker.services.lists import InstallerWorkService, ListService
        lists, plans = InMemoryListRepository(), InMemoryRoutePlanRepository()
        service = ListService(lists)
        first = service.save_installer("sijil", phone="5550102000")
        service.save_installer("Sai", allow_no_phone=True)
        self.assertTrue(first.id)
        self.stores.update_fields("p1", "a", {"installer_name": "Sijil", "install_type": "Technician"})
        self.stores.update_fields("p1", "b", {"installer_name": "Sai", "install_type": "Technician"})
        start = StartLocation(address="Depot", lat=33.7, lng=-84.4)
        plan = RoutePlan(name="GA", installers=[PlanInstaller(name="sijil", start=start)],
                         days=[PlanDay(number=1, date="2026-11-06", starts={"sijil": start})],
                         locked_days=[{"installer": "sijil", "day": 1}])
        plans.put(plan)
        plans.put_stops(plan.id, [PlanStop(project_id="p1", stop_uid="a", installer="sijil", day=1)])
        with self.assertRaises(ValidationFailed):  # another installer already has that name
            service.save_installer("sijil", phone="5550102000", new_name="sai")
        saved = service.save_installer("sijil", phone="5550102000", phone2="555 010 3000", email2="s@example.com",
                                       new_name="Sijil Thomas")
        self.assertEqual((saved.id, saved.value, saved.phone2, saved.email2),
                         (first.id, "Sijil Thomas", "555 010 3000", "s@example.com"))
        self.assertEqual([e.value for e in lists.list_names(NameListKind.INSTALLERS).items], ["Sai", "Sijil Thomas"])
        work = InstallerWorkService(lists, self.projects, self.stores, plans)
        self.assertEqual(work.rename_records("sijil", saved.value), (1, 1))
        self.assertEqual(self.stores.get("p1", "a").installer_name, "Sijil Thomas")
        self.assertEqual(self.stores.get("p1", "b").installer_name, "Sai")
        renamed = plans.get(plan.id)
        self.assertEqual(renamed.installer_names(), ["Sijil Thomas"])
        self.assertEqual(list(renamed.days[0].starts), ["Sijil Thomas"])
        self.assertEqual(renamed.locked(), {("Sijil Thomas", 1)})
        self.assertEqual([stop.installer for stop in plans.list_stops(plan.id)], ["Sijil Thomas"])
        # A change of case only is a rename too: same entry, records follow.
        again = service.save_installer("Sijil Thomas", phone="5550102000", new_name="SIJIL THOMAS")
        self.assertEqual((again.id, len(lists.list_names(NameListKind.INSTALLERS).items)), (first.id, 2))
        with self.assertRaises(ValidationFailed) as caught:
            service.save_installer("Sai", phone="5550102000", phone2="12")
        self.assertIn("phone2", caught.exception.detail["fields"])


class ScreenCostSheetTests(StoresApiTestCase):
    SHEET = (
        "ExtID,Store Address,Venue ID,Stick Count,Screen Size,Screen Count,Cost per Screen,Cost Note\n"
        'X1,"1 Main St, Atlanta, Georgia 30303",dd_one,1,43",0,$175.00,\n'
        'X1,"1 Main St, Atlanta, Georgia 30303",DD-TWO,1,24",1,$500.00,checked\n'
        'X9,"9 Far Rd, Macon, Georgia 31201",DD-NOWHERE,1,50",1,$750.00,\n'
    )

    def send(self, apply=False):
        import base64
        content = base64.b64encode(self.SHEET.encode()).decode()
        body = {"filename": "costs.csv", "content_base64": content, "apply": apply}
        response = self.client.post("/api/projects/p1/screen-sheet", json=body)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_matches_by_dd_code_sets_size_and_owner_and_checks_the_cost(self):
        screens = [Screen(venue_id="DD-ONE"), Screen(venue_id="DD-TWO", screen_size='24"')]
        self.stores.update_fields("p1", "a", {"screens": [screen.model_dump(mode="json") for screen in screens]})
        prices = {"stick": 175, "screens": [{"size": "24", "type": "Dolphin", "cost": 300}]}  # the sheet says 325
        self.client.patch("/api/projects/p1", json={"hardware_costs": prices})
        preview = self.send()
        self.assertEqual((preview["matched"], preview["changing"], preview["unmatched"], preview["cost_differs"]),
                         (2, 1, 1, 1))
        one, two, nowhere = preview["rows"]
        self.assertEqual((one["size_from"], one["size_to"], one["dolphin_from"], one["dolphin_to"]),
                         ('24"', '43"', True, False))  # no Dolphin screen: the store's own TV, a stick only
        self.assertEqual((one["our_cost"], one["cost_differs"]), (175, False))
        self.assertEqual((two["changes"], two["our_cost"], two["sheet_cost"], two["cost_differs"], two["note"]),
                         (False, 475, 500, True, "checked"))
        self.assertFalse(nowhere["matched"])
        self.assertEqual(self.stores.get("p1", "a").screens[0].screen_size, '24"')  # a preview writes nothing
        applied = self.send(apply=True)
        self.assertEqual((applied["applied"], applied["screens_updated"]), (True, 1))
        saved = self.stores.get("p1", "a").screens
        self.assertEqual([(s.screen_size, s.is_dolphin_screen) for s in saved], [('43"', False), ('24"', True)])
        self.assertEqual(self.send()["changing"], 0)  # nothing left to change

    def test_cost_is_worked_out_from_the_stick_and_screen_counts(self):
        import base64
        screens = [Screen(venue_id="DD-ONE"), Screen(venue_id="DD-TWO"), Screen(venue_id="DD-SIX", screen_size='43"'),
                   Screen(venue_id="DD-BIG")]
        self.stores.update_fields("p1", "a", {"screens": [screen.model_dump(mode="json") for screen in screens]})
        prices = {"stick": 175, "screens": [{"size": "24", "cost": 325}, {"size": "43", "cost": 375}]}
        self.client.patch("/api/projects/p1", json={"hardware_costs": prices})
        sheet = ("ExtID,Store Address,Venue ID,Stick Count,Screen Size,Screen Count\n"
                 'X1,1 Main St,DD-ONE,1,43",0\n'   # the store's own TV: the stick only
                 'X1,1 Main St,DD-TWO,1,24",1\n'   # stick + a 24 inch screen
                 "X1,1 Main St,DD-SIX,1,,\n"       # no size or count: left as it is (a 43 inch Dolphin screen)
                 'X1,1 Main St,DD-BIG,1,65",1\n')  # no price for 65 inch
        body = {"filename": "s.csv", "content_base64": base64.b64encode(sheet.encode()).decode()}
        result = self.client.post("/api/projects/p1/screen-sheet", json=body).json()
        self.assertEqual([row["our_cost"] for row in result["rows"]], [175, 500, 550, None])
        self.assertEqual([row["sheet_cost"] for row in result["rows"]], [None] * 4)  # the sheet has no cost column
        self.assertEqual((result["total_cost"], result["unpriced"], result["cost_differs"]), (1225, 1, 0))
        self.assertEqual((result["rows"][2]["changes"], result["rows"][2]["dolphin_to"]), (False, True))

    def test_refuses_a_sheet_without_dd_codes(self):
        import base64
        body = {"filename": "x.csv", "content_base64": base64.b64encode(b"ExtID,Size\nX1,24\n").decode()}
        self.assertEqual(self.client.post("/api/projects/p1/screen-sheet", json=body).status_code, 422)


class ScreenListTests(StoresApiTestCase):
    def test_one_row_per_screen_with_its_store(self):
        stores = self.client.get("/api/projects/p1/stores", params={"limit": 200}).json()["items"]
        page = self.client.get("/api/projects/p1/stores/screens", params={"limit": 200}).json()
        self.assertEqual(page["total"], sum(len(store["screens"]) for store in stores))
        row = page["items"][0]
        store = next(item for item in stores if item["uid"] == row["uid"])
        self.assertEqual((row["store_name"], row["city"], row["state"]),
                         (store["store_name"], store["place_city"], store["place_state"]))
        self.assertIn(row["screen"]["id"], [screen["id"] for screen in store["screens"]])

    def test_status_filters_keep_screens_not_whole_stores(self):
        screens = [Screen(status="Completed", venue_id="DD_ON"), Screen(status="Upcoming", venue_id="DD_UP"),
                   Screen(status="Not Registered", venue_id="DD_NR", is_dolphin_screen=False, screen_type="LG")]
        self.stores.update_fields("p1", "a", {"screens": [screen.model_dump(mode="json") for screen in screens]})

        def codes(**params):
            page = self.client.get("/api/projects/p1/stores/screens", params={"limit": 200, **params}).json()
            return [item["screen"]["venue_id"] for item in page["items"] if item["uid"] == "a"]

        self.assertEqual(codes(status="Completed"), ["DD_ON"])  # the store itself reads Upcoming
        self.assertEqual(codes(bucket="In Progress"), ["DD_NR"])  # the store group's name for Not Registered
        self.assertEqual(codes(dd_code="DD_UP"), ["DD_UP"])
        self.assertEqual(codes(sort="brand")[0], "DD_NR")  # the only one with a brand; blanks last
        self.assertEqual(codes(sort="owner", dir="desc")[0], "DD_NR")  # store TVs first
        self.assertEqual(self.client.get("/api/projects/p1/stores/screens", params={"sort": "nope"}).status_code, 400)


# --- City and state as shown: from the verified address, not what was typed ---

def test_city_and_state_come_from_the_verified_address() -> None:
    typed = Stop(uid="a", store_name="A", addr="1 Main St", city="houston ", state="texas",
                 geocoded="1 Main St, Houston, TX 77002, USA")
    assert (typed.place_city, typed.place_state) == ("Houston", "TX")
    unverified = Stop(uid="b", store_name="B", addr="1 Main St", city="Macon", state="georgia")
    assert (unverified.place_city, unverified.place_state) == ("Macon", "GA")  # typed, the state as its code
    assert (typed.city, typed.state) == ("houston ", "texas")  # what was typed is kept (duplicates match on it)


class PlaceFilterTests(StoresApiTestCase):
    def test_state_filter_uses_the_shown_state(self):
        self.stores.update_fields("p1", "a", {"state": "georgia", "geocoded": "1 Main St, Dallas, TX 75201, USA"})
        states = {o["value"] for o in self.client.get("/api/projects/p1/stores/filters").json()["state"]}
        self.assertIn("TX", states)
        self.assertNotIn("georgia", states)
        page = self.client.get("/api/projects/p1/stores", params={"state": "TX"}).json()
        self.assertEqual([item["uid"] for item in page["items"]], ["a"])
        self.assertEqual((page["items"][0]["place_city"], page["items"][0]["place_state"]), ("Dallas", "TX"))


# --- Add one store by hand: the checks a sheet row gets ---------------------------------------------------------------

class AddStoreTests(StoresApiTestCase):
    def add(self, **values):
        body = {"external_id": "GA90001", "store_name": "New Mart", "addr": "99 New St", "city": "Atlanta",
                "state": "GA", "zip": "30303", **values}
        return self.client.post("/api/projects/p1/stores", json=body)

    def test_adds_a_verified_store(self):
        response = self.add()
        self.assertEqual(response.status_code, 201, response.text)
        added = response.json()
        self.assertEqual((added["external_id"], added["store_name"], added["lat"], added["needs_attention"]),
                         ("GA90001", "New Mart", 33.9, []))
        self.assertEqual(added["geocoded"], "99 New St, Atlanta, GA 30303, USA")
        self.assertEqual(self.client.get("/api/projects/p1/stores", params={"q": "GA90001"}).json()["total"], 1)

    def test_ibc_name_and_address_are_required(self):
        response = self.add(external_id=" ", store_name="", addr="")
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(set(response.json()["detail"]["fields"]), {"external_id", "store_name", "addr"})

    def test_an_ibc_or_address_already_in_the_project_is_refused(self):
        self.assertEqual(self.add().status_code, 201)
        again = self.add(store_name="Other", addr="5 Elsewhere Rd")
        self.assertEqual(again.status_code, 422, again.text)
        problem = again.json()["detail"]["fields"]["external_id"]
        self.assertIn("ExtID GA90001 is already in the project: New Mart", problem)
        same_place = self.add(external_id="GA90002")
        self.assertEqual(same_place.status_code, 422, same_place.text)
        self.assertIn("This address is already in the project", same_place.json()["detail"]["fields"]["addr"])

    def test_an_address_google_cannot_verify_is_refused_with_suggestions(self):
        partial = self.add(addr="Main")
        self.assertEqual(partial.status_code, 422, partial.text)
        self.assertIn("could not be verified", partial.json()["detail"]["message"])
        unknown = self.add(addr="nowhere")
        self.assertEqual(unknown.json()["detail"]["suggestions"], ["1 Nowhere Ln, Atlanta, GA, USA"])
        self.assertEqual(self.client.get("/api/projects/p1/stores", params={"q": "GA90001"}).json()["total"], 0)


def test_one_default_price_per_size() -> None:
    costs = HardwareCosts(stick=1, screens=[
        {"size": "24", "type": "Dolphin", "cost": 325}, {"size": "24", "type": "Dell", "cost": 200, "is_default": True},
        {"size": "43", "type": "Dolphin", "cost": 375},
    ])
    assert [(row.size, row.type, row.is_default) for row in costs.screens] == [
        ('24"', "Dolphin", False), ('24"', "Dell", True), ('43"', "Dolphin", True)]  # unmarked size: its first row
    assert [row.cost for row in costs.screens] == [200, 200, 375]  # the size's cost is its default's
