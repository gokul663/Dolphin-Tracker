"""Device report sync: matching, status rules, overlay, alerts, review list, overwrite; service, API and DynamoDB."""
import unittest

import boto3
from fastapi.testclient import TestClient
from moto import mock_aws

from dolphin_tracker.api.app import create_app
from dolphin_tracker.api.deps import (
    get_device_data,
    get_device_review_repository,
    get_geocoder,
    get_project_repository,
    get_store_repository,
)
from dolphin_tracker.domain.device import DeviceRecord, DeviceSnapshot, ReviewItem, split_codes, venue_code_key
from dolphin_tracker.domain.device_sync import (
    index_records,
    overwrite_changes,
    review_items,
    sync_stop,
)
from dolphin_tracker.domain.errors import ConflictError, ValidationFailed
from dolphin_tracker.domain.models import Project, ProjectType, Screen, ScreenInput, ScreenStatus, Stop
from dolphin_tracker.repositories.device_review import DynamoDeviceReviewRepository
from dolphin_tracker.repositories.dynamo import TABLE_DEFINITION
from dolphin_tracker.repositories.memory import (
    InMemoryDeviceReviewRepository,
    InMemoryProjectRepository,
    InMemoryStoreRepository,
)
from dolphin_tracker.repositories.stores import DynamoStoreRepository
from dolphin_tracker.services.device_sync import DeviceSyncService
from dolphin_tracker.services.stores import StoreService
from tests.fakes import FakeDeviceData, FakeGeocoder, geocode_ok, report_row

INGESTED = "2026-11-10T03:02:06+00:00"


def snapshot(*rows: dict) -> DeviceSnapshot:
    return DeviceSnapshot(pa="IBC", date="2026-11-09", ingested_at=INGESTED,
                          records=[DeviceRecord.from_report(row) for row in rows])


def stop(uid: str, *screens: Screen, **extra) -> Stop:
    return Stop(uid=uid, display_id=uid.upper(), external_id=f"IBC-{uid.upper()}", store_name=f"Sheet {uid}",
                addr=f"{len(uid)} Main St", city="Atlanta", state="GA", lat=33.7, lng=-84.4,
                screens=list(screens), **extra)


class MatchingTests(unittest.TestCase):
    def test_dash_underscore_case_and_spaces_are_the_same_venue(self):
        self.assertEqual(venue_code_key("DD-ABC123"), venue_code_key(" dd_abc123 "))
        self.assertEqual(venue_code_key("DD - ABC123"), "DD_ABC123")

    def test_report_row_parsing(self):
        record = DeviceRecord.from_report(report_row("DD_HFN64S"))
        self.assertEqual(record.date, "2026-11-09")
        self.assertEqual(record.last_seen, "2026-11-09T22:03:51+00:00")
        self.assertEqual((record.addr, record.city, record.state, record.zip),
                         ("5680 Stadium Dr", "Kalamazoo", "MI", "49009"))
        self.assertEqual(record.venue_name, "CMS_DD_HFN64S")

    def test_old_rows_with_nulls_and_text_last_seen(self):
        record = DeviceRecord.from_report(report_row(
            "DD_HEXGCX", Address=None, City=None, **{"State Code": None, "State": None, "Latitude": None,
                                                     "Longitude": None, "Last Seen (UTC)": "2026-03-02T08:34:13 CST"}
        ))
        self.assertEqual((record.addr, record.city, record.state), ("", "", ""))
        self.assertIsNone(record.lat)
        self.assertEqual(record.last_seen, "2026-03-02T08:34:13 CST")


class PackedCellTests(unittest.TestCase):
    def test_split_codes(self):
        cases = {
            "DD-HJGK7Z. DD-HB8P6I": ["DD-HJGK7Z", "DD-HB8P6I"],
            "DD-002-02969. DD-002-01380": ["DD-002-02969", "DD-002-01380"],
            "DD-1, DD-2;DD-3 / DD-4\nDD-5": ["DD-1", "DD-2", "DD-3", "DD-4", "DD-5"],
            "DD_HFN64S DD_HB8P6I": ["DD_HFN64S", "DD_HB8P6I"],
            "DD - ABC123": ["DD - ABC123"],
            "DD-HFN64S.": ["DD-HFN64S"],
            "": [],
        }
        for cell, expected in cases.items():
            with self.subTest(cell=cell):
                self.assertEqual(split_codes(cell), expected)

    def test_sync_flags_a_packed_entry_for_review_instead_of_splitting(self):
        packed = Screen(id="s1", venue_id="DD-HJGK7Z. DD-HB8P6I", stick_number="A. B", status="Completed")
        store = stop("a", packed)
        snap = snapshot(report_row("DD_HJGK7Z"), report_row("DD_HB8P6I", "Offline"))
        changes = sync_stop(store, index_records(snap.records), snap, "2026-11-10T12:00:00+00:00")
        self.assertEqual(changes["needs_attention"], ["dd_code_review"])  # not "not_reporting"
        self.assertNotIn("screens", changes)  # left as typed
        self.assertEqual(review_items(snap.records, [store], {}, snap.date), [])  # the store covers both codes

    def test_flag_clears_once_the_screens_are_split_by_hand(self):
        projects, stores = InMemoryProjectRepository(), InMemoryStoreRepository()
        projects.put(Project(id="p1", name="P", pa="IBC", project_type=ProjectType.OFFLINE))
        stores.put_many("p1", [stop("a", Screen(id="s1", venue_id="DD-HJGK7Z. DD-HB8P6I"),
                                    needs_attention=["dd_code_review"])])
        fixed = StoreService(stores, projects).update_screens("p1", "a", [
            ScreenInput(id="s1", venue_id="DD-HJGK7Z"), ScreenInput(venue_id="DD-HB8P6I")])
        self.assertEqual(fixed.needs_attention, [])
        self.assertEqual(len(fixed.screens), 2)

    def test_import_keeps_the_entry_and_asks_for_review_with_a_suggestion(self):
        from dolphin_tracker.domain.import_mapping import STICK_NUMBERS, VENUE_IDS, build_screens, packed_code_problem

        row = {STICK_NUMBERS: "DD-002-02969. DD-002-01380", VENUE_IDS: "DD-HJGK7Z. DD-HB8P6I"}
        self.assertEqual([screen["venue_id"] for screen in build_screens(row, ScreenStatus.COMPLETED)],
                         ["DD-HJGK7Z. DD-HB8P6I"])
        problem = packed_code_problem(row)
        self.assertIn("2 codes", problem)
        self.assertIn("DD-HJGK7Z (stick DD-002-02969); DD-HB8P6I (stick DD-002-01380)", problem)
        self.assertEqual(packed_code_problem({VENUE_IDS: "DD-1, DD-2"}), "")  # commas already make two screens


class SyncRuleTests(unittest.TestCase):
    NOW = "2026-11-10T12:00:00+00:00"

    def run_sync(self, store: Stop, *rows: dict, ignored_date: str = "") -> dict:
        snap = snapshot(*rows)
        return sync_stop(store, index_records(snap.records), snap, self.NOW)

    def test_report_status_sets_work_status(self):
        cases = [("Online", "Upcoming", "Completed"), ("Offline", "Completed", "Offline"),
                 ("Archived", "Completed", "Archived"), ("Online", "Serviced - Needs More Work", "Completed"),
                 ("Online", "Cancelled", "Cancelled"), ("Not Registered", "Upcoming", "Upcoming"),
                 ("Testing", "Shipped", "Shipped")]
        for report, before, after in cases:
            with self.subTest(report=report, before=before):
                store = stop("a", Screen(venue_id="DD-HFN64S", status=before))
                changes = self.run_sync(store, report_row("DD_HFN64S", report))
                self.assertEqual(changes["screens"][0]["status"], after)
                self.assertEqual(changes["screens"][0]["device"]["status"], report)
                stamped = changes["screens"][0]["status_changed_at"]
                self.assertEqual(stamped, self.NOW if before != after else "")

    def test_store_gets_report_values_over_the_sheet(self):
        store = stop("a", Screen(venue_id="DD-HFN64S"))
        changes = self.run_sync(store, report_row("DD_HFN64S"))
        self.assertEqual(changes["device"]["store_name"], "Store DD_HFN64S")
        self.assertEqual(changes["device"]["lat"], 42.2675)
        self.assertNotIn("store_name", changes)  # the sheet value stays underneath

    def test_nothing_to_write_when_already_in_line(self):
        store = stop("a", Screen(venue_id="DD-HFN64S"))
        snap = snapshot(report_row("DD_HFN64S"))
        synced = Stop.model_validate({**store.model_dump(), **sync_stop(store, index_records(snap.records), snap,
                                                                        self.NOW)})
        self.assertEqual(sync_stop(synced, index_records(snap.records), snap, self.NOW), {})

    def test_completed_but_missing_from_the_report_needs_attention(self):
        store = stop("a", Screen(venue_id="DD-GONE01", status="Completed"))
        self.assertEqual(self.run_sync(store, report_row("DD_OTHER1"))["needs_attention"], ["not_reporting"])

    def test_completed_after_the_report_was_loaded_is_not_flagged(self):
        store = stop("a", Screen(venue_id="DD-GONE01", status="Completed",
                                 status_changed_at="2026-11-10T09:00:00+00:00"))
        self.assertNotIn("needs_attention", self.run_sync(store, report_row("DD_OTHER1")))

    def test_completed_before_the_report_is_flagged(self):
        store = stop("a", Screen(venue_id="DD-GONE01", status="Completed",
                                 status_changed_at="2026-11-09T09:00:00+00:00"))
        self.assertEqual(self.run_sync(store, report_row("DD_OTHER1"))["needs_attention"], ["not_reporting"])

    def test_ignored_for_this_report_day_but_not_the_next(self):
        store = stop("a", Screen(venue_id="DD-GONE01", status="Completed"), device_alert_ignored="2026-11-09")
        self.assertEqual(self.run_sync(store, report_row("DD_OTHER1")), {})
        snap = snapshot(report_row("DD_OTHER1")).model_copy(update={"date": "2026-11-10"})
        changes = sync_stop(store, index_records(snap.records), snap, self.NOW)
        self.assertEqual(changes["needs_attention"], ["not_reporting"])

    def test_no_dd_code_or_not_completed_is_not_flagged(self):
        store = stop("a", Screen(venue_id="", status="Completed"), Screen(venue_id="DD-X1", status="Upcoming"))
        self.assertEqual(self.run_sync(store, report_row("DD_OTHER1")), {})

    def test_flag_clears_when_the_screen_reports_again(self):
        store = stop("a", Screen(venue_id="DD-HFN64S", status="Completed"), needs_attention=["not_reporting"])
        self.assertEqual(self.run_sync(store, report_row("DD_HFN64S"))["needs_attention"], [])

    def test_review_lists_unknown_venues_but_not_archived(self):
        stores = [stop("a", Screen(venue_id="DD-KNOWN1"))]
        records = [DeviceRecord.from_report(row) for row in (
            report_row("DD_KNOWN1"), report_row("DD_NEW001"), report_row("DD_OLD001", "Archived"))]
        self.assertEqual([item.key for item in review_items(records, stores, {}, "2026-11-09")], ["DD_NEW001"])

    def test_not_now_lasts_until_a_newer_report_day(self):
        records = [DeviceRecord.from_report(report_row("DD_NEW001"))]
        same = review_items(records, [], {"DD_NEW001": "2026-11-09"}, "2026-11-09")
        newer = review_items(records, [], {"DD_NEW001": "2026-11-09"}, "2026-11-10")
        self.assertEqual((same[0].snoozed_date, newer[0].snoozed_date), ("2026-11-09", ""))

    def test_overwrite_copies_report_values(self):
        store = stop("a", Screen(venue_id="DD-HFN64S"), needs_attention=["address"])
        snap = snapshot(report_row("DD_HFN64S"))
        store = Stop.model_validate({**store.model_dump(), **sync_stop(store, index_records(snap.records), snap,
                                                                       self.NOW)})
        changes = overwrite_changes(store, ["store_name", "location"])
        self.assertEqual(changes["store_name"], "Store DD_HFN64S")
        self.assertEqual((changes["lat"], changes["lng"], changes["route_stale"]), (42.2675, -85.661, True))
        self.assertEqual(changes["needs_attention"], [])
        self.assertEqual(overwrite_changes(store.model_copy(update={"device": None}), ["store_name"]), {})


class ServiceTestCase(unittest.TestCase):
    def setUp(self):
        self.projects = InMemoryProjectRepository()
        self.projects.put(Project(id="p1", name="P", pa="IBC", device_pa="IBC", project_type=ProjectType.OFFLINE))
        self.stores = InMemoryStoreRepository()
        self.stores.put_many("p1", [
            stop("a", Screen(venue_id="DD-HFN64S")),
            stop("b", Screen(venue_id="DD-OFF001", status="Completed")),
            stop("c", Screen(venue_id="DD-GONE01", status="Completed")),
        ])
        self.reviews = InMemoryDeviceReviewRepository()
        self.source = FakeDeviceData([
            report_row("DD_HFN64S"), report_row("DD_OFF001", "Offline"), report_row("DD_NEW001"),
            report_row("DD_NEW002", "Not Registered", Address=None, City=None,
                       **{"Latitude": None, "Longitude": None, "State Code": None, "Zip Code": None}),
            report_row("DD_ARC001", "Archived"), report_row("DD_ELSE01", **{"PA Name": "Other PA"}),
        ])
        def verified(line: str, lat: float, city: str, state: str, zip_code: str) -> dict:
            return geocode_ok(line, lat=lat, lng=-85.6, city=city, state=state, zip=zip_code)

        self.geocoder = FakeGeocoder(geocodes={
            "1 Lake Rd, Kalamazoo, MI 49009": verified("1 Lake Rd", 42.29, "Kalamazoo", "MI", "49009"),
            "9 Elm St, Macon, GA 31201": verified("9 Elm St", 32.84, "Macon", "GA", "31201"),
            "500 Rail Rd, Ponchatoula, LA 70454": verified("500 Rail Rd", 30.44, "Ponchatoula", "LA", "70454"),
        })
        self.service = DeviceSyncService(self.projects, self.stores, self.reviews, self.source,
                                         geocoder=self.geocoder)


class ServiceTests(ServiceTestCase):
    def test_sync_updates_statuses_overlay_alerts_and_review(self):
        result = self.service.sync("p1")
        self.assertTrue(result.synced)
        self.assertEqual(self.stores.get("p1", "a").status, ScreenStatus.COMPLETED)
        self.assertEqual(self.stores.get("p1", "b").status, ScreenStatus.OFFLINE)
        self.assertEqual(self.stores.get("p1", "a").device.city, "Kalamazoo")
        self.assertEqual(self.stores.get("p1", "c").needs_attention, ["not_reporting"])
        state = self.projects.get("p1").device_sync
        self.assertEqual((state.snapshot_date, state.matched_screens, state.status_changes), ("2026-11-09", 2, 2))
        self.assertEqual((state.review_count, state.not_reporting), (2, 1))
        self.assertEqual([item.key for item in self.service.review("p1").items], ["DD_NEW001", "DD_NEW002"])

    def test_only_if_stale_skips_the_same_day_and_runs_on_a_newer_one(self):
        self.service.sync("p1")
        self.assertFalse(self.service.sync("p1", only_if_stale=True).synced)
        self.source.date = "2026-11-10"
        self.assertTrue(self.service.sync("p1", only_if_stale=True).synced)
        self.assertEqual(len(self.source.snapshots), 2)

    def test_not_now_hides_until_the_next_report_day(self):
        self.service.sync("p1")
        self.service.snooze("p1", "dd-new001")
        page = self.service.review("p1")
        self.assertEqual(([item.key for item in page.items], page.snoozed), (["DD_NEW002"], 1))
        self.assertEqual(self.projects.get("p1").device_sync.review_count, 1)
        self.service.sync("p1")  # same day: still hidden
        self.assertEqual(self.service.review("p1").total, 1)
        self.source.date = "2026-11-10"
        self.service.sync("p1")
        self.assertEqual(self.service.review("p1").total, 2)

    def test_add_from_review_creates_the_store_with_report_values(self):
        self.source.rows[2] = report_row("DD_NEW001", Address="1 Lake Rd, Kalamazoo, MI 49009")
        self.service.sync("p1")
        added = self.service.add_from_review("p1", "DD_NEW001")
        # Verified with Google like an imported row: Google's location, the report's stays as Dolphin data.
        self.assertEqual((added.store_name, added.addr, added.lat), ("Store DD_NEW001", "1 Lake Rd", 42.29))
        self.assertEqual(added.device.lat, 42.2675)
        self.assertIn(("geocode", "1 Lake Rd, Kalamazoo, MI 49009"), self.geocoder.calls)
        self.assertEqual(added.screens[0].venue_id, "DD_NEW001")
        self.assertEqual(added.status, ScreenStatus.COMPLETED)
        self.assertEqual(added.screens[0].device.status, "Online")
        self.assertEqual((added.external_id, added.needs_attention), ("", ["external_id"]))  # no IBC#: asked for
        self.assertEqual(self.projects.get("p1").pa, "IBC")  # the report's PA name does not join the project's
        self.assertEqual(self.service.review("p1").total, 1)

    def test_no_address_in_the_report_asks_for_one(self):
        self.service.sync("p1")
        with self.assertRaises(ValidationFailed) as raised:
            self.service.add_from_review("p1", "DD_NEW002")
        self.assertIn("no address", raised.exception.detail["message"])
        self.assertEqual(self.service.review("p1").total, 2)  # still waiting

    def test_a_typed_address_is_checked_with_google(self):
        self.service.sync("p1")
        added = self.service.add_from_review("p1", "DD_NEW002", address="500 Rail Rd, Ponchatoula, LA 70454")
        self.assertEqual((added.addr, added.city, added.lat, added.needs_attention), ("500 Rail Rd", "Ponchatoula",
                                                                                      30.44, ["external_id"]))
        self.assertEqual(added.status, ScreenStatus.UPCOMING)  # Not Registered: no status change

    def test_an_unverifiable_address_is_refused_with_suggestions_unless_added_anyway(self):
        self.geocoder.autocompletes["9 Nowhere Ln"] = ["9 Nowhere Ln, Macon, GA, USA"]
        self.service.sync("p1")
        with self.assertRaises(ValidationFailed) as raised:
            self.service.add_from_review("p1", "DD_NEW002", address="9 Nowhere Ln")
        self.assertIn("could not verify", raised.exception.detail["message"])
        added = self.service.add_from_review("p1", "DD_NEW002", address="9 Nowhere Ln", add_anyway=True)
        self.assertIsNone(added.lat)
        self.assertEqual(added.needs_attention, ["external_id", "address"])

    def test_a_picked_google_place_is_used_as_is(self):
        self.service.sync("p1")
        place = {"lat": 30.45, "lng": -90.44, "formatted": "LA22 Mart, 1 Hwy 22, Ponchatoula, LA 70454",
                 "addr": "1 Hwy 22", "city": "Ponchatoula", "state": "LA", "zip": "70454"}
        added = self.service.add_from_review("p1", "DD_NEW002", place=place)
        self.assertEqual((added.addr, added.lat, added.geocoded), ("1 Hwy 22", 30.45, place["formatted"]))
        self.assertEqual(added.needs_attention, ["external_id"])

    def test_the_cms_ibc_number_is_used_when_it_has_one(self):
        self.source.rows[2] = report_row("DD_NEW001", Address="1 Lake Rd, Kalamazoo, MI 49009",
                                         **{"PK External ID": "MI23285"})
        self.service.sync("p1")
        added = self.service.add_from_review("p1", "DD_NEW001")
        self.assertEqual((added.external_id, added.needs_attention), ("MI23285", []))

    def test_the_ibc_number_is_entered_once_then_fixed(self):
        self.service.sync("p1")
        added = self.service.add_from_review("p1", "DD_NEW002", address="500 Rail Rd, Ponchatoula, LA 70454")
        stores = StoreService(self.stores, self.projects)
        with self.assertRaises(ConflictError):
            stores.set_external_id("p1", added.uid, "ibc-a")  # store a holds IBC-a
        saved = stores.set_external_id("p1", added.uid, " la70454 ")
        self.assertEqual((saved.external_id, saved.needs_attention), ("LA70454", []))
        with self.assertRaises(ConflictError):
            stores.set_external_id("p1", added.uid, "LA99999")

    def test_add_joins_the_store_already_at_that_address(self):
        # Store "a" (sheet address 1 Main St) synced, so its Dolphin data address is 5680 Stadium Dr, Kalamazoo.
        self.service.sync("p1")
        added = self.service.add_from_review("p1", "DD_NEW001")
        self.assertEqual(added.uid, "a")
        self.assertEqual([screen.venue_id for screen in added.screens], ["DD-HFN64S", "DD_NEW001"])
        self.assertEqual(added.screens[1].device.status, "Online")
        self.assertEqual(added.screens[0].device.status, "Online")  # the other stick keeps its sync values
        self.assertEqual(len(self.stores.list_all("p1")), 3)

    def test_two_sticks_of_a_new_store_become_one_store(self):
        self.source.rows = [report_row("DD_NEW00A", Address="9 Elm St, Macon, GA 31201", City="Macon",
                                       **{"State Code": "GA", "Zip Code": "31201"}),
                            report_row("DD_NEW00B", Address="9 Elm St, Macon, GA 31201", City="Macon",
                                       **{"State Code": "GA", "Zip Code": "31201"})]
        self.service.sync("p1")
        first = self.service.add_from_review("p1", "DD_NEW00A")
        second = self.service.add_from_review("p1", "DD_NEW00B")
        self.assertEqual(first.uid, second.uid)
        self.assertEqual([screen.venue_id for screen in second.screens], ["DD_NEW00A", "DD_NEW00B"])
        self.assertEqual(len(self.stores.list_all("p1")), 4)

    def test_add_joins_the_store_with_the_same_ibc_number(self):
        self.source.rows = [report_row("DD_NEW00C", **{"PK External ID": "IBC-c", "Address": "77 Far Rd, Reno, NV"})]
        self.service.sync("p1")
        self.assertEqual(self.service.add_from_review("p1", "DD_NEW00C").uid, "c")

    def test_ignore_alert_until_next_day(self):
        self.service.sync("p1")
        self.assertEqual(self.service.ignore_alert("p1", "c").needs_attention, [])
        self.assertEqual(self.projects.get("p1").device_sync.not_reporting, 0)
        self.service.sync("p1")
        self.assertEqual(self.stores.get("p1", "c").needs_attention, [])
        self.source.date = "2026-11-10"
        self.service.sync("p1")
        self.assertEqual(self.stores.get("p1", "c").needs_attention, ["not_reporting"])

    def test_overwrite_one_store_or_all(self):
        self.service.sync("p1")
        self.assertEqual(self.service.overwrite("p1", ["city"], "a").stores_updated, 1)
        self.assertEqual(self.stores.get("p1", "a").city, "Kalamazoo")
        self.assertEqual(self.service.overwrite("p1", ["store_name"]).stores_updated, 2)  # a and b are synced
        self.assertEqual(self.stores.get("p1", "c").store_name, "Sheet c")

    def test_manual_screen_edit_keeps_device_values_and_stamps_the_change(self):
        self.service.sync("p1")
        current = self.stores.get("p1", "a").screens[0]
        edited = StoreService(self.stores, self.projects).update_screens(
            "p1", "a", [ScreenInput(id=current.id, venue_id=current.venue_id, status="Offline")])
        self.assertEqual(edited.screens[0].device.status, "Online")
        self.assertNotEqual(edited.screens[0].status_changed_at, current.status_changed_at)

    def test_changing_the_pa_restarts_the_sync(self):
        from dolphin_tracker.services.projects import ProjectService

        self.service.sync("p1")
        ProjectService(self.projects, self.stores).update("p1", {"device_pa": "Other PA"})
        self.assertIsNone(self.projects.get("p1").device_sync)

    def test_sync_all_only_projects_with_a_pa(self):
        self.projects.put(Project(id="p2", name="Q", pa="X", project_type=ProjectType.OFFLINE))
        self.assertEqual(self.service.sync_all(), {"synced": 1, "failed": []})


class ApiTests(ServiceTestCase):
    def setUp(self):
        super().setUp()
        self.app = create_app()
        self.app.dependency_overrides[get_project_repository] = lambda: self.projects
        self.app.dependency_overrides[get_store_repository] = lambda: self.stores
        self.app.dependency_overrides[get_device_review_repository] = lambda: self.reviews
        self.app.dependency_overrides[get_device_data] = lambda: self.source
        self.app.dependency_overrides[get_geocoder] = lambda: FakeGeocoder()
        self.client = TestClient(self.app)

    def test_pa_list_sync_review_and_add(self):
        self.assertEqual(self.client.get("/api/device-data/pas").json(),
                         {"date": "2026-11-09", "pas": ["IBC", "Other PA"]})
        body = self.client.post("/api/projects/p1/device-sync").json()
        self.assertEqual(body["state"]["review_count"], 2)
        review = self.client.get("/api/projects/p1/device-sync/review", params={"limit": 1}).json()
        self.assertEqual((review["total"], len(review["items"]), bool(review["next_cursor"])), (2, 1, True))
        added = self.client.post("/api/projects/p1/device-sync/review/DD_NEW001/add")
        self.assertEqual(added.status_code, 201)
        self.assertEqual(added.json()["uid"], "a")  # same address as store a's Dolphin data: a second stick there
        self.assertEqual(self.client.post("/api/projects/p1/device-sync/review/DD_NEW001/add").status_code, 404)
        pins = {pin["uid"]: pin for pin in self.client.get("/api/projects/p1/stores/pins").json()}
        self.assertEqual(pins["a"]["lat"], 42.2675)  # the report's location
        self.assertEqual(pins["c"]["lat"], 33.7)

    def test_overwrite_and_ignore(self):
        self.client.post("/api/projects/p1/device-sync")
        response = self.client.post("/api/projects/p1/stores/a/device-overwrite", json={"fields": ["location"]})
        self.assertEqual(response.json(), {"stores_updated": 1})
        self.assertEqual(self.client.post("/api/projects/p1/device-sync/overwrite",
                                          json={"fields": ["nope"]}).status_code, 422)
        ignored = self.client.post("/api/projects/p1/stores/c/device-alert/ignore").json()
        self.assertEqual(ignored["needs_attention"], [])

    def test_search_finds_report_names(self):
        self.client.post("/api/projects/p1/device-sync")
        page = self.client.get("/api/projects/p1/stores", params={"q": "cms_dd_hfn64s"}).json()
        self.assertEqual([item["uid"] for item in page["items"]], ["a"])

    def test_set_pa_then_sync_without_a_source_or_pa(self):
        self.projects.update("p1", {"device_pa": ""})
        self.assertEqual(self.client.post("/api/projects/p1/device-sync").status_code, 422)
        self.assertEqual(self.client.patch("/api/projects/p1", json={"device_pa": "IBC"}).json()["device_pa"], "IBC")
        self.app.dependency_overrides[get_device_data] = lambda: None
        self.assertEqual(self.client.post("/api/projects/p1/device-sync").status_code, 503)
        self.assertEqual(self.client.get("/api/device-data/pas").status_code, 503)


@mock_aws
class DynamoTests(unittest.TestCase):
    def setUp(self):
        table = boto3.resource("dynamodb", region_name="us-east-1").create_table(
            TableName="dolphin-tracker-test", **TABLE_DEFINITION)
        self.reviews = DynamoDeviceReviewRepository(table)
        self.stores = DynamoStoreRepository(table)

    def item(self, key: str, **extra) -> ReviewItem:
        record = DeviceRecord.from_report(report_row(key))
        return ReviewItem(**record.model_dump(), key=key, **extra)

    def test_replace_writes_changes_and_deletes_the_rest(self):
        self.assertEqual(self.reviews.replace("p1", [self.item("DD_A"), self.item("DD_B")]), 2)
        self.assertEqual(self.reviews.replace("p1", [self.item("DD_A"), self.item("DD_C")]), 2)  # C new, B gone
        self.assertEqual([item.key for item in self.reviews.list("p1")], ["DD_A", "DD_C"])
        self.assertEqual(self.reviews.get("p1", "DD_A").lat, 42.2675)
        self.reviews.put("p1", self.item("DD_A", snoozed_date="2026-11-09"))
        self.assertEqual(self.reviews.get("p1", "DD_A").snoozed_date, "2026-11-09")

    def test_device_writes_and_project_delete(self):
        self.stores.put_many("p1", [stop("a", Screen(venue_id="DD-HFN64S"))])
        snap = snapshot(report_row("DD_HFN64S"))
        changes = sync_stop(self.stores.get("p1", "a"), index_records(snap.records), snap, "2026-11-10T12:00:00+00:00")
        self.assertEqual(self.stores.update_device_many("p1", [("a", changes)]), 1)
        saved = self.stores.get("p1", "a")
        self.assertEqual((saved.status, saved.device.lng), (ScreenStatus.COMPLETED, -85.661))
        with self.assertRaises(ValueError):
            self.stores.update_device_many("p1", [("a", {"installer": "x"})])
        self.reviews.replace("p1", [self.item("DD_A")])
        self.stores.put_many("p1", [stop("n", Screen(venue_id="DD-N1")).model_copy(
            update={"external_id": "", "needs_attention": ["external_id"]})])
        self.assertEqual(self.stores.set_external_id("p1", "n", "LA1", []).external_id, "LA1")
        with self.assertRaises(ConflictError):
            self.stores.set_external_id("p1", "n", "LA2", [])  # already has one
        with self.assertRaises(ConflictError):
            self.stores.set_external_id("p1", "a", "LA1", [])  # another store holds it
        self.stores.delete_all("p1")
        self.assertEqual(self.reviews.list("p1"), [])
