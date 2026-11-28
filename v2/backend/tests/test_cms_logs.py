"""Tracker's log entries in the shared log collection (domain/cms_log.py, services/cms_logs.py): written on save,
insert only, off unless switched on, and sent again after a failure."""
import unittest

import boto3
from moto import mock_aws

from dolphin_tracker.config import Settings
from dolphin_tracker.domain.cms_log import SOURCE
from dolphin_tracker.domain.models import Project, ProjectType
from dolphin_tracker.domain.visits import StoreCommentInput, VisitInput
from dolphin_tracker.handlers.device_data import dispatch
from dolphin_tracker.repositories.device_data import MongoDeviceData
from dolphin_tracker.repositories.dynamo import TABLE_DEFINITION
from dolphin_tracker.repositories.memory import (
    InMemoryListRepository,
    InMemoryProjectRepository,
    InMemoryStoreRepository,
    InMemoryVisitRepository,
)
from dolphin_tracker.repositories.stores import DynamoStoreRepository
from dolphin_tracker.repositories.visits import DynamoVisitRepository
from dolphin_tracker.services.cms_logs import CmsLogWriter
from dolphin_tracker.services.lists import ListService
from dolphin_tracker.services.visits import VisitService
from tests.fakes import FakeDeviceData
from tests.test_visits import form, make_stop

# The fields every entry of the older system has (read from the collection): Tracker's must have them all, as text.
OLD_FIELDS = {
    "address", "category", "contact_number", "created_at", "date", "dd_code", "detailed_comments",
    "dolphin_manager", "fa", "id", "installer", "kiosk_mode", "latest_apk", "network_type", "owner_email",
    "owner_name", "pa", "stick_model", "stick_number", "store_name", "venue_name", "wifi_autoconnect", "wifi_name",
    "wifi_password",
}


class CmsLogTests(unittest.TestCase):
    def setUp(self):
        self.projects = InMemoryProjectRepository()
        self.projects.put(Project(id="p1", name="P", pa="North PA", field_agent="Fay",
                                  project_type=ProjectType.OFFLINE))
        self.stores = InMemoryStoreRepository()
        self.stores.put_many("p1", [make_stop()])
        self.visits = InMemoryVisitRepository(self.stores)
        self.mongo = FakeDeviceData()

    def service(self, *, enabled: bool = True) -> VisitService:
        return VisitService(self.visits, self.stores, self.projects, ListService(InMemoryListRepository()), None,
                            CmsLogWriter(self.mongo, enabled=enabled))

    def test_a_visit_is_written_in_the_older_systems_shape_with_its_source(self):
        body = VisitInput.model_validate(form(dd_code="dd-1", outcome="done", dagent_installed=True,
                                              wifi_ssid="Guest", wifi_password="pw"))
        visit = self.service().create("p1", "u1", body, logged_by="Dana Admin")
        self.assertTrue(visit.cms_logged_at)
        [log] = self.mongo.added
        self.assertLessEqual(OLD_FIELDS, set(log))
        self.assertTrue(all(isinstance(value, str) for value in log.values()))
        self.assertEqual(
            {key: log[key] for key in ("source", "logged_by", "tracker_id", "entry_type", "date", "dd_code",
                                       "store_name", "address", "pa", "fa", "installer", "dolphin_manager",
                                       "category", "subcategory", "outcome", "network_type", "latest_apk",
                                       "kiosk_mode", "dagent_installed", "wifi_name", "contact_number")},
            {"source": SOURCE, "logged_by": "Dana Admin", "tracker_id": visit.id, "entry_type": "screen",
             "date": "2026-11-06", "dd_code": "DD_1", "store_name": "Awami Markaz",
             "address": "1 Main St, Atlanta, GA, 30303", "pa": "North PA", "fa": "Fay", "installer": "Ann",
             "dolphin_manager": "Zoe", "category": "Power Issues", "subcategory": "TV Off", "outcome": "done",
             "network_type": "wifi", "latest_apk": "yes", "kiosk_mode": "no", "dagent_installed": "yes",
             "wifi_name": "Guest", "contact_number": "404-555-0100"},
        )
        self.assertEqual(log["created_at"], visit.created_at)
        self.assertEqual(len(log["id"]), 36)  # dashed, like the older entries' ids
        # Saved in Tracker with the mark, too.
        self.assertEqual(self.visits.list_for_store("p1", "u1").items[0].cms_logged_at, visit.cms_logged_at)

    def test_a_store_comment_is_written_as_a_store_entry(self):
        comment = self.service().add_comment(
            "p1", "u1", StoreCommentInput(text="Gate code 1234", visit_date="2026-11-06", dolphin_manager="Zoe"),
            created_by="Dana Admin",
        )
        [log] = self.mongo.added
        self.assertLessEqual(OLD_FIELDS, set(log))
        self.assertEqual((log["entry_type"], log["dd_code"], log["category"], log["detailed_comments"],
                          log["logged_by"], log["store_name"], log["source"]),
                         ("store", "", "Store Comment", "Gate code 1234", "Dana Admin", "Awami Markaz", SOURCE))
        self.assertTrue(comment.cms_logged_at)

    def test_off_by_default_nothing_is_written(self):
        visit = self.service(enabled=False).create("p1", "u1", VisitInput.model_validate(form()))
        self.assertEqual((self.mongo.added, visit.cms_logged_at), ([], ""))
        self.assertFalse(Settings(_env_file=None).cms_log_write)

    def test_a_failed_write_keeps_the_entry_and_sends_it_with_the_next_one(self):
        self.mongo.down = True
        first = self.service().create("p1", "u1", VisitInput.model_validate(form()))  # saved; no error for the person
        self.assertEqual((first.cms_logged_at, self.mongo.added), ("", []))
        self.assertEqual(len(self.visits.list_for_store("p1", "u1").items), 1)
        self.mongo.down = False
        second = self.service().create("p1", "u1", VisitInput.model_validate(form(screen_id="s2", dd_code="DD_2")))
        self.assertEqual({log["tracker_id"] for log in self.mongo.added}, {first.id, second.id})
        self.assertTrue(all(visit.cms_logged_at for visit in self.visits.list_for_store("p1", "u1").items))
        # …and nothing is sent twice after that.
        self.service().create("p1", "u1", VisitInput.model_validate(form()))
        self.assertEqual(len(self.mongo.added), 3)


class FakeLogs:
    """The `logs` collection as pymongo shows it; fails the test on anything but a read or an insert."""

    def __init__(self):
        self.docs: list[dict] = []

    def find_one(self, query, projection=None, **_):
        return next((doc for doc in self.docs if all(doc.get(k) == v for k, v in query.items())), None)

    def insert_one(self, doc):
        self.docs.append(doc)

    def __getattr__(self, name):  # update_one, delete_one, replace_one, drop…
        raise AssertionError(f"{name} must never be called on the log collection")


class FakeMongoClient:
    def __init__(self):
        self.logs = FakeLogs()

    def __getitem__(self, _database):
        return self

    def get_collection(self, name, **_):
        assert name == "logs"
        return self.logs


class MongoWriteTests(unittest.TestCase):
    def test_add_log_inserts_once_and_never_changes_what_is_there(self):
        client = FakeMongoClient()
        source = MongoDeviceData("mongodb://unused", client=client)
        log = {"tracker_id": "abc", "source": SOURCE, "detailed_comments": "first"}
        self.assertTrue(source.add_log(log))
        self.assertFalse(source.add_log({**log, "detailed_comments": "changed"}))  # a retry: left as it is
        self.assertEqual([doc["detailed_comments"] for doc in client.logs.docs], ["first"])

    def test_the_lambda_takes_add_log_and_refuses_anything_but_text(self):
        mongo = FakeDeviceData()
        self.assertEqual(dispatch({"op": "add_log", "log": {"tracker_id": "abc", "source": SOURCE}}, mongo),
                         {"ok": True, "inserted": True})
        self.assertEqual(dispatch({"op": "add_log", "log": {"tracker_id": "abc"}}, mongo),
                         {"ok": True, "inserted": False})
        self.assertFalse(dispatch({"op": "add_log", "log": {"tracker_id": 5}}, mongo)["ok"])
        self.assertFalse(dispatch({"op": "add_log"}, mongo)["ok"])


@mock_aws
class DynamoMarkTests(unittest.TestCase):
    def test_mark_cms_logged_sets_the_time_on_the_saved_entry(self):
        table = boto3.resource("dynamodb", region_name="us-east-1").create_table(TableName="t", **TABLE_DEFINITION)
        DynamoStoreRepository(table).put_many("p1", [make_stop()])
        visits = DynamoVisitRepository(table)
        projects = InMemoryProjectRepository()
        projects.put(Project(id="p1", name="P", project_type=ProjectType.OFFLINE))
        mongo = FakeDeviceData()
        service = VisitService(visits, DynamoStoreRepository(table), projects, ListService(InMemoryListRepository()),
                               None, CmsLogWriter(mongo, enabled=True))
        visit = service.create("p1", "u1", VisitInput.model_validate(form()))
        comment = service.add_comment("p1", "u1", StoreCommentInput(text="Gate", visit_date="2026-11-06"))
        self.assertEqual(visits.list_for_store("p1", "u1").items[0].cms_logged_at, visit.cms_logged_at)
        self.assertEqual(visits.list_store_comments("p1", "u1").items[0].cms_logged_at, comment.cms_logged_at)
        self.assertEqual(len(mongo.added), 2)


if __name__ == "__main__":
    unittest.main()
