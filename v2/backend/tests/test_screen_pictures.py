"""A screen's pictures (STORE-MODEL §4.1): links kept with the screen through screens updates, merges and both
repositories; changing them is a screen edit (an Operator only while the store is on a route)."""
import unittest

import boto3
from fastapi.testclient import TestClient
from moto import mock_aws

from dolphin_tracker.api.app import create_app
from dolphin_tracker.api.deps import (
    get_list_repository,
    get_project_repository,
    get_store_repository,
    get_visit_repository,
)
from dolphin_tracker.domain.models import (
    MAX_SCREEN_PICTURES,
    Project,
    ProjectType,
    Screen,
    ScreenInput,
    Stop,
    merge_same_code,
)
from dolphin_tracker.repositories.dynamo import TABLE_DEFINITION
from dolphin_tracker.repositories.memory import (
    InMemoryListRepository,
    InMemoryProjectRepository,
    InMemoryStoreRepository,
    InMemoryVisitRepository,
)
from dolphin_tracker.repositories.stores import DynamoStoreRepository
from dolphin_tracker.services.stores import StoreService

A = "https://drive.google.com/file/d/abc/view"
B = "https://example.com/b.jpg"
C = "https://example.com/c.jpg"
OPERATOR = {"X-Dev-Role": "operator"}


def make_stop() -> Stop:
    return Stop(uid="u1", external_id="IBC-1", store_name="Mart", addr="1 Main St", city="Atlanta", state="GA",
                zip="30303", screens=[Screen(id="s1", stick_number="ST-1", venue_id="DD_1"),
                                      Screen(id="s2", stick_number="ST-2", venue_id="DD_2")])


def visit_form(**overrides) -> dict:
    body = {
        "screen_id": "s1", "visit_date": "2026-11-06", "dd_code": "DD_1", "venue_name": "D_005_KIOSK",
        "stick_number": "ST-1", "installer": "Ann", "dolphin_manager": "Zoe", "network_type": "WiFi",
        "latest_apk": True, "kiosk_mode": False, "dagent_installed": True, "category": "Power Issues",
        "subcategory": "TV Off", "outcome": "done",
    }
    body.update(overrides)
    return body


class ScreenPictureModelTests(unittest.TestCase):
    def test_links_are_cleaned_and_capped(self):
        self.assertEqual(Screen(pictures=[f" {A} ", "", A, B]).pictures, [A, B])
        self.assertEqual(Screen().pictures, [])
        with self.assertRaises(ValueError):
            Screen(pictures=["not a link"])
        with self.assertRaises(ValueError):
            ScreenInput(pictures=[f"https://example.com/{n}.jpg" for n in range(MAX_SCREEN_PICTURES + 1)])
        self.assertIsNone(ScreenInput().pictures)  # left out: the screen keeps its own

    def test_merged_rows_keep_every_picture(self):
        merged = merge_same_code([Screen(id="x", venue_id="DD-H5036X", pictures=[A, B]),
                                  Screen(id="y", venue_id="DD_H5036X", pictures=[B, C])])
        self.assertEqual([(row.id, row.pictures) for row in merged], [("x", [A, B, C])])


class ScreenPictureRepositoryTests(unittest.TestCase):
    def test_round_trip_through_dynamo(self):
        mock = mock_aws()
        mock.start()
        self.addCleanup(mock.stop)
        table = boto3.resource("dynamodb", region_name="us-east-1").create_table(
            TableName="dolphin-tracker-test", **TABLE_DEFINITION)
        repo = DynamoStoreRepository(table)
        repo.put_many("p1", [make_stop()])
        projects = InMemoryProjectRepository()
        projects.put(Project(id="p1", name="P", pa="North", project_type=ProjectType.OFFLINE))
        service = StoreService(repo, projects)
        service.update_screens("p1", "u1", [ScreenInput(id="s1", venue_id="DD_1", pictures=[A]),
                                             ScreenInput(id="s2", venue_id="DD_2")])
        self.assertEqual([screen.pictures for screen in repo.get("p1", "u1").screens], [[A], []])


class ScreenPictureApiTests(unittest.TestCase):
    def setUp(self):
        self.projects = InMemoryProjectRepository()
        self.projects.put(Project(id="p1", name="P", pa="North", project_type=ProjectType.OFFLINE))
        self.stores = InMemoryStoreRepository()
        self.stores.put_many("p1", [make_stop()])
        visits = InMemoryVisitRepository(self.stores)
        lists = InMemoryListRepository()
        app = create_app()
        app.dependency_overrides[get_project_repository] = lambda: self.projects
        app.dependency_overrides[get_store_repository] = lambda: self.stores
        app.dependency_overrides[get_visit_repository] = lambda: visits
        app.dependency_overrides[get_list_repository] = lambda: lists
        self.client = TestClient(app)

    def put(self, screens: list[dict], headers: dict | None = None):
        return self.client.put("/api/projects/p1/stores/u1/screens", json={"screens": screens}, headers=headers)

    def test_kept_by_an_update_that_leaves_them_out_and_gone_with_the_screen(self):
        saved = self.put([{"id": "s1", "venue_id": "DD_1", "pictures": [A, B]}, {"id": "s2", "venue_id": "DD_2"}])
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual([row["pictures"] for row in saved.json()["screens"]], [[A, B], []])
        # An unrelated change from a client that does not send pictures: they stay.
        renamed = self.put([{"id": "s1", "venue_id": "DD_1", "stick_number": "ST-9"}, {"id": "s2", "venue_id": "DD_2"}])
        self.assertEqual(renamed.json()["screens"][0]["pictures"], [A, B])
        # Sent back: the list is what was sent (one removed).
        removed = self.put([{"id": "s1", "venue_id": "DD_1", "pictures": [B]}, {"id": "s2", "venue_id": "DD_2"}])
        self.assertEqual(removed.json()["screens"][0]["pictures"], [B])
        # The screen deleted: its pictures go with it; a new row starts with none.
        dropped = self.put([{"id": "s2", "venue_id": "DD_2"}, {"venue_id": "DD_3"}])
        self.assertEqual([row["pictures"] for row in dropped.json()["screens"]], [[], []])
        too_many = [f"https://example.com/{n}.jpg" for n in range(MAX_SCREEN_PICTURES + 1)]
        self.assertEqual(self.put([{"id": "s2", "venue_id": "DD_2", "pictures": too_many}]).status_code, 422)
        self.assertEqual(self.put([{"id": "s2", "venue_id": "DD_2", "pictures": ["ftp://x/y.jpg"]}]).status_code, 422)

    def test_operator_off_route_logs_a_visit_but_cannot_change_pictures(self):
        logged = self.client.post("/api/projects/p1/stores/u1/visits", json=visit_form(), headers=OPERATOR)
        self.assertEqual(logged.status_code, 201, logged.text)
        self.assertEqual(logged.json()["route_plan_id"], "")  # off a route: no plan
        refused = self.put([{"id": "s1", "venue_id": "DD_1", "pictures": [A]}, {"id": "s2", "venue_id": "DD_2"}],
                           headers=OPERATOR)
        self.assertEqual((refused.status_code, "active route" in refused.text), (403, True))
        self.stores.claim_for_plan("p1", ["u1"], "plan1", "2026-11-06T00:00:00+00:00")
        allowed = self.put([{"id": "s1", "venue_id": "DD_1", "pictures": [A]}, {"id": "s2", "venue_id": "DD_2"}],
                           headers=OPERATOR)
        self.assertEqual((allowed.status_code, allowed.json()["screens"][0]["pictures"]), (200, [A]))
