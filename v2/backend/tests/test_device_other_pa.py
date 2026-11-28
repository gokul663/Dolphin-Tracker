"""Screens of another PA (or none) at one of the project's addresses: listed on each sync for a check, never added;
"Reviewed, it's fine" hides one until its PA or our store changes."""
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
from dolphin_tracker.domain.device import DeviceRecord, OtherPaScreen
from dolphin_tracker.domain.device_sync import other_pa_screens, other_pa_situation
from dolphin_tracker.domain.models import Project, ProjectType, Screen, Stop
from dolphin_tracker.domain.venues import venue_stop
from dolphin_tracker.repositories.device_review import DynamoDeviceReviewRepository
from dolphin_tracker.repositories.dynamo import TABLE_DEFINITION
from dolphin_tracker.repositories.memory import (
    InMemoryDeviceReviewRepository,
    InMemoryProjectRepository,
    InMemoryStoreRepository,
)
from dolphin_tracker.repositories.stores import DynamoStoreRepository
from dolphin_tracker.services.device_sync import DeviceSyncService
from tests.fakes import FakeDeviceData, FakeGeocoder, report_row

PA = "IBC Bakeries"


def at(address: str, city: str = "Macon", state: str = "GA", zip_code: str = "31201") -> dict:
    """Report fields for a venue at this street."""
    return {"Address": f"{address}, {city}, {state} {zip_code}", "City": city, "State Code": state,
            "Zip Code": zip_code}


def row(code: str, pa: str, address: str, status: str = "Online", **extra) -> dict:
    return report_row(code, status, **{"PA Name": pa, **at(address), **extra})


def store(uid: str, addr: str, *codes: str, **extra) -> Stop:
    return Stop(uid=uid, display_id=uid.upper(), external_id=f"EXT-{uid.upper()}", store_name=f"Store {uid}",
                addr=addr, city="Macon", state="GA", zip="31201", lat=32.8, lng=-83.6,
                screens=[Screen(venue_id=code) for code in codes] or [Screen()], **extra)


class OtherPaRuleTests(unittest.TestCase):
    def venue(self, code: str, pa: str, address: str = "10 Oak St", status: str = "Online") -> Stop:
        return venue_stop(DeviceRecord.from_report(row(code, pa, address, status)))

    def test_rules(self):
        stops = [store("s1", "10 Oak St", "DD-OWN1"), store("s2", "20 Pine St", "DD-OWN2"),
                 store("s3", "", "DD-OWN3")]
        venues = [
            self.venue("DD_ATM1", "ATM Co"),  # another PA at s1
            self.venue("DD_ATM2", ""),  # no PA at s1: two venues at one address
            self.venue("DD_SAME", "  ibc   BAKERIES "),  # ours, spelled otherwise: not a candidate
            self.venue("DD_OWN2", "ATM Co", "20 Pine St"),  # its DD code is already in s2
            self.venue("DD_FAR1", "ATM Co", "99 Elm St"),  # at none of our addresses
            self.venue("DD_NOAD", "ATM Co", ""),  # no street: matches nothing (s3 has none either)
        ]
        items = other_pa_screens(venues, stops, PA, set())
        self.assertEqual([(item.venue_id, item.stop_uid, item.pa_name) for item in items],
                         [("DD_ATM1", "s1", "ATM Co"), ("DD_ATM2", "s1", "")])
        self.assertEqual((items[0].status, items[0].venue_name, items[0].external_id, items[0].address),
                         ("Online", "CMS_DD_ATM1", "EXT-S1", "10 Oak St, Macon, GA 31201"))

    def test_archived_venue_is_skipped(self):
        archived = self.venue("DD_ATM1", "ATM Co", status="Archived")
        self.assertEqual(other_pa_screens([archived], [store("s1", "10 Oak St")], PA, set()), [])

    def test_inert_without_a_device_pa(self):
        self.assertEqual(other_pa_screens([self.venue("DD_ATM1", "ATM Co")], [store("s1", "10 Oak St")], "", set()),
                         [])

    def test_matches_the_stores_dolphin_data_address_too(self):
        from dolphin_tracker.domain.device import StoreDevice

        moved = store("s1", "1 Sheet Rd", device=StoreDevice(addr="10 Oak St", city="Macon", state="GA", zip="31201"))
        self.assertEqual(len(other_pa_screens([self.venue("DD_ATM1", "ATM Co")], [moved], PA, set())), 1)

    def test_a_reviewed_situation_is_screen_store_and_pa(self):
        venue = self.venue("DD_ATM1", "ATM Co")
        stops = [store("s1", "10 Oak St")]
        [item] = other_pa_screens([venue], stops, PA, set())
        reviewed = {other_pa_situation(item)}
        self.assertEqual(other_pa_screens([venue], stops, PA, reviewed), [])
        self.assertEqual(other_pa_screens([self.venue("DD_ATM1", "atm  co")], stops, PA, reviewed), [])  # same PA
        self.assertEqual(len(other_pa_screens([self.venue("DD_ATM1", "Other Co")], stops, PA, reviewed)), 1)
        self.assertEqual(len(other_pa_screens([self.venue("DD_ATM1", "")], stops, PA, reviewed)), 1)
        # Another store of ours at that address (s1 renumbered, say) is a new situation.
        self.assertEqual(len(other_pa_screens([venue], [store("s9", "10 Oak St")], PA, reviewed)), 1)


class OtherPaServiceTests(unittest.TestCase):
    def setUp(self):
        self.projects = InMemoryProjectRepository()
        self.projects.put(Project(id="p1", name="P", pa="IBC", device_pa=PA, project_type=ProjectType.OFFLINE))
        self.stores = InMemoryStoreRepository()
        self.stores.put_many("p1", [store("s1", "10 Oak St", "DD-OWN1"), store("s2", "20 Pine St", "DD-OWN2")])
        self.reviews = InMemoryDeviceReviewRepository()
        self.source = FakeDeviceData([
            row("DD_OWN1", PA, "10 Oak St"), row("DD_OWN2", PA, "20 Pine St"),
            row("DD_ATM1", "ATM Co", "10 OAK ST"), row("DD_ATM2", "", "10 Oak St", "Offline"),
            row("DD_ATM3", "ATM Co", "20 Pine St"),
        ])
        self.service = DeviceSyncService(self.projects, self.stores, self.reviews, self.source,
                                         geocoder=FakeGeocoder())

    def sync(self) -> list[str]:
        """The worker's order: every venue of every PA (and none), then the project's sync."""
        self.service.refresh_venues()
        self.service.sync("p1")
        return [item.key for item in self.service.other_pa("p1").items]

    def set_pa(self, code: str, pa: str) -> None:
        next(r for r in self.source.rows if r["Venue ID"] == code)["PA Name"] = pa

    def test_listed_counted_and_nothing_in_the_project_changes(self):
        before = {stop.uid: stop.screens for stop in self.stores.list_all("p1")}
        self.assertEqual(self.sync(), ["DD_ATM1:s1", "DD_ATM2:s1", "DD_ATM3:s2"])
        self.assertEqual(self.projects.get("p1").device_sync.other_pa_count, 3)
        self.assertEqual([len(screens) for screens in before.values()],
                         [len(stop.screens) for stop in self.stores.list_all("p1")])
        self.assertEqual(self.service.review("p1").total, 0)  # not in the new-records list either
        page = self.service.other_pa("p1", limit=2)
        self.assertEqual((page.total, len(page.items), bool(page.next_cursor)), (3, 2, True))
        self.assertEqual(len(self.service.other_pa("p1", limit=2, cursor=page.next_cursor).items), 1)

    def test_reviewed_stays_hidden_until_the_pa_changes(self):
        self.sync()
        self.service.mark_other_pa_reviewed("p1", "DD_ATM1:s1")
        self.service.mark_other_pa_reviewed("p1", "DD_ATM2:s1")
        self.assertEqual(self.projects.get("p1").device_sync.other_pa_count, 1)
        self.assertEqual(self.sync(), ["DD_ATM3:s2"])  # unchanged: still hidden
        self.set_pa("DD_ATM1", "Other Co")  # PA1 → PA2
        self.set_pa("DD_ATM2", "ATM Co")  # blank → a PA
        self.assertEqual(self.sync(), ["DD_ATM1:s1", "DD_ATM2:s1", "DD_ATM3:s2"])

    def test_back_under_our_pa_it_is_a_new_record_to_add_despite_the_review(self):
        self.sync()
        self.service.mark_other_pa_reviewed("p1", "DD_ATM1:s1")
        self.set_pa("DD_ATM1", PA.lower())  # ours, under another spelling: the CMS fixed it
        self.assertEqual(self.sync(), ["DD_ATM2:s1", "DD_ATM3:s2"])
        self.set_pa("DD_ATM1", PA)
        self.assertEqual(self.sync(), ["DD_ATM2:s1", "DD_ATM3:s2"])
        self.assertEqual([item.key for item in self.service.review("p1").items], ["DD_ATM1"])
        added = self.service.add_from_review("p1", "DD_ATM1")
        self.assertEqual(added.uid, "s1")  # joins our store at that address
        self.assertEqual(self.sync(), ["DD_ATM2:s1", "DD_ATM3:s2"])  # its code is in s1 now

    def test_archived_later_drops_out(self):
        self.assertIn("DD_ATM3:s2", self.sync())
        next(r for r in self.source.rows if r["Venue ID"] == "DD_ATM3")["Status"] = "Archived"
        self.assertNotIn("DD_ATM3:s2", self.sync())

    def test_the_daily_run_reads_every_pa_before_the_projects(self):
        self.service.sync_all()
        self.assertEqual(len(self.service.other_pa("p1").items), 3)  # the same report day, in one run

    def test_marking_one_no_longer_listed(self):
        from dolphin_tracker.domain.errors import NotFoundError

        self.sync()
        with self.assertRaises(NotFoundError):
            self.service.mark_other_pa_reviewed("p1", "DD_NOPE:s1")


class OtherPaApiTests(OtherPaServiceTests):
    def setUp(self):
        super().setUp()
        app = create_app()
        app.dependency_overrides[get_project_repository] = lambda: self.projects
        app.dependency_overrides[get_store_repository] = lambda: self.stores
        app.dependency_overrides[get_device_review_repository] = lambda: self.reviews
        app.dependency_overrides[get_device_data] = lambda: self.source
        app.dependency_overrides[get_geocoder] = lambda: FakeGeocoder()
        self.client = TestClient(app)

    def test_list_and_mark_reviewed(self):
        self.service.refresh_venues()
        body = self.client.post("/api/projects/p1/device-sync").json()
        self.assertEqual(body["state"]["other_pa_count"], 3)
        page = self.client.get("/api/projects/p1/device-sync/other-pa", params={"limit": 1}).json()
        self.assertEqual((page["total"], page["items"][0]["key"], bool(page["next_cursor"])), (3, "DD_ATM1:s1", True))
        self.assertEqual(page["items"][0]["pa_name"], "ATM Co")
        done = self.client.post("/api/projects/p1/device-sync/other-pa/DD_ATM1:s1/reviewed")
        self.assertEqual(done.status_code, 200, done.text)
        self.assertEqual(self.client.post("/api/projects/p1/device-sync/other-pa/DD_ATM1:s1/reviewed").status_code,
                         404)
        self.assertEqual(self.client.get("/api/projects/p1").json()["device_sync"]["other_pa_count"], 2)


@mock_aws
class OtherPaDynamoTests(unittest.TestCase):
    def setUp(self):
        table = boto3.resource("dynamodb", region_name="us-east-1").create_table(
            TableName="dolphin-tracker-test", **TABLE_DEFINITION)
        self.reviews = DynamoDeviceReviewRepository(table)
        self.stores = DynamoStoreRepository(table)

    def item(self, key: str, pa: str = "ATM Co") -> OtherPaScreen:
        code, uid = key.split(":")
        return OtherPaScreen(key=key, venue_id=code, pa_name=pa, stop_uid=uid, store_name="Store")

    def test_replace_markers_and_project_delete(self):
        self.reviews.replace("p1", [])
        self.assertEqual(self.reviews.replace_other_pa("p1", [self.item("DD_A:s1"), self.item("DD_B:s1")]), 2)
        self.assertEqual(self.reviews.replace_other_pa("p1", [self.item("DD_A:s1"), self.item("DD_C:s2", "")]), 2)
        self.assertEqual([item.key for item in self.reviews.list_other_pa("p1")], ["DD_A:s1", "DD_C:s2"])
        self.assertEqual(self.reviews.list("p1"), [])  # never mixed into the new-records list
        situation = other_pa_situation(self.reviews.get_other_pa("p1", "DD_C:s2"))
        self.reviews.mark_other_pa_reviewed("p1", situation)
        self.reviews.delete_other_pa("p1", "DD_C:s2")
        self.assertEqual(self.reviews.reviewed_other_pa("p1"), {"DD_C:s2:"})
        self.assertEqual([item.key for item in self.reviews.list_other_pa("p1")], ["DD_A:s1"])
        self.stores.delete_all("p1")
        self.assertEqual((self.reviews.list_other_pa("p1"), self.reviews.reviewed_other_pa("p1")), ([], set()))


class NoPaVenueTests(unittest.TestCase):
    def test_the_device_data_lambda_reads_the_venues_with_no_pa(self):
        from dolphin_tracker.handlers.device_data import dispatch

        source = FakeDeviceData([row("DD_ATM2", "", "10 Oak St"), row("DD_OWN1", PA, "10 Oak St")])
        body = dispatch({"op": "snapshot", "pa": ""}, source)
        self.assertEqual([record["venue_id"] for record in body["snapshot"]["records"]], ["DD_ATM2"])
        self.assertEqual(dispatch({"op": "snapshot"}, source), {"ok": False, "error": "pa is required"})
