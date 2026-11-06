"""Servicing visits (ROUTE-PLANNER §3, §5): per-stick visits, the store's summary, service rules, API."""
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
from dolphin_tracker.domain.errors import NotFoundError, ValidationFailed
from dolphin_tracker.domain.lists import NameListKind
from dolphin_tracker.domain.models import Project, ProjectType, Screen, ScreenStatus, Stop
from dolphin_tracker.domain.visits import Visit, VisitInput, VisitState, visit_state
from dolphin_tracker.repositories.dynamo import TABLE_DEFINITION
from dolphin_tracker.repositories.memory import (
    InMemoryListRepository,
    InMemoryProjectRepository,
    InMemoryStoreRepository,
    InMemoryVisitRepository,
)
from dolphin_tracker.repositories.stores import DynamoStoreRepository
from dolphin_tracker.repositories.visits import DynamoVisitRepository
from dolphin_tracker.services.lists import ListService
from dolphin_tracker.services.visits import VisitService


def make_stop() -> Stop:
    return Stop(
        uid="u1", external_id="IBC-1", store_name="Awami Markaz", addr="1 Main St", city="Atlanta", state="GA",
        zip="30303", owner_name="Sam", owner_phone="404-555-0100", onsite_contact_name="Lee",
        screens=[Screen(id="s1", stick_number="ST-1", venue_id="DD_1", status=ScreenStatus.OFFLINE),
                 Screen(id="s2", stick_number="ST-2", venue_id="DD_2", status=ScreenStatus.OFFLINE)],
    )


def form(**overrides) -> dict:
    body = {
        "screen_id": "s1", "visit_date": "2026-11-06", "dd_code": "DD_1", "venue_name": "D_005_KIOSK",
        "stick_number": "ST-1", "installer": "Ann", "dolphin_manager": "Zoe", "network_type": "WiFi",
        "latest_apk": True, "kiosk_mode": False, "category": "Power Issues", "subcategory": "TV Off",
        "comments": "plugged back in",
    }
    body.update(overrides)
    return body


class VisitStateTests(unittest.TestCase):
    def test_every_stick_since_the_latest_plan(self):
        ids = ["s1", "s2"]
        self.assertEqual(visit_state(ids, {}), VisitState.NONE)
        self.assertEqual(visit_state(ids, {"s1": "2026-11-02"}), VisitState.PARTLY)
        self.assertEqual(visit_state(ids, {"s1": "2026-11-02", "s2": "2026-11-03"}), VisitState.VISITED)
        # Planned again on 11-03: the 11-02 visit no longer counts.
        self.assertEqual(visit_state(ids, {"s1": "2026-11-02", "s2": "2026-11-03"}, "2026-11-03"), VisitState.PARTLY)
        self.assertEqual(visit_state(ids, {"gone": "2026-11-02"}), VisitState.NONE)
        self.assertEqual(visit_state([], {"s1": "x"}), VisitState.NONE)

    def test_form_cleans_text_and_requires_fields(self):
        cleaned = VisitInput.model_validate(form(dolphin_manager="  Zoe   Park "))
        self.assertEqual(cleaned.dolphin_manager, "Zoe Park")
        for missing in ("dd_code", "venue_name", "stick_number", "installer", "dolphin_manager", "network_type",
                        "latest_apk", "kiosk_mode", "category", "subcategory", "visit_date"):
            with self.subTest(missing=missing), self.assertRaises(ValueError):
                body = form()
                body.pop(missing)
                VisitInput.model_validate(body)
        with self.assertRaises(ValueError):
            VisitInput.model_validate(form(venue_name="   "))
        with self.assertRaises(ValueError):
            VisitInput.model_validate(form(network_type="5G"))


class VisitRepositoryContract:
    stores: object
    repo: object

    def test_add_updates_the_store_summary_without_touching_status(self):
        self.stores.put_many("p1", [make_stop()])
        before = self.stores.get("p1", "u1")
        first = Visit(**form(), project_id="p1", stop_uid="u1", created_at="2026-11-06T10:00:00+00:00")
        second = Visit(**form(screen_id="s2"), project_id="p1", stop_uid="u1", created_at="2026-11-06T11:00:00+00:00")
        self.repo.add(first)
        self.repo.add(second)
        after = self.stores.get("p1", "u1")
        self.assertEqual(after.screen_visits, {"s1": first.created_at, "s2": second.created_at})
        self.assertEqual(after.last_visit_at, second.created_at)
        self.assertEqual(after.status, ScreenStatus.OFFLINE)  # a visit is not a status change
        self.assertEqual(after.updated_at, before.updated_at)  # nor an edit

    def test_history_newest_first_and_paged(self):
        self.stores.put_many("p1", [make_stop(), make_stop().model_copy(update={"uid": "u2", "external_id": ""})])
        for hour in range(3):
            self.repo.add(Visit(**form(), project_id="p1", stop_uid="u1", created_at=f"2026-11-06T1{hour}:00:00Z"))
        self.repo.add(Visit(**form(), project_id="p1", stop_uid="u2", created_at="2026-11-06T09:00:00Z"))
        page = self.repo.list_for_store("p1", "u1", limit=2)
        self.assertEqual([v.created_at for v in page.items], ["2026-11-06T12:00:00Z", "2026-11-06T11:00:00Z"])
        rest = self.repo.list_for_store("p1", "u1", limit=2, cursor=page.next_cursor)
        self.assertEqual(([v.created_at for v in rest.items], rest.next_cursor), (["2026-11-06T10:00:00Z"], None))

    def test_missing_store(self):
        with self.assertRaises(NotFoundError):
            self.repo.add(Visit(**form(), project_id="p1", stop_uid="nope"))
        self.assertEqual(self.repo.list_for_store("p1", "nope").items, [])


class InMemoryVisitRepositoryTests(VisitRepositoryContract, unittest.TestCase):
    def setUp(self):
        self.stores = InMemoryStoreRepository()
        self.repo = InMemoryVisitRepository(self.stores)


class DynamoVisitRepositoryTests(VisitRepositoryContract, unittest.TestCase):
    def setUp(self):
        mock = mock_aws()
        mock.start()
        self.addCleanup(mock.stop)
        resource = boto3.resource("dynamodb", region_name="us-east-1")
        self.table = resource.create_table(TableName="dolphin-tracker-test", **TABLE_DEFINITION)
        self.stores = DynamoStoreRepository(self.table)
        self.repo = DynamoVisitRepository(self.table)

    def test_project_delete_takes_the_visits(self):
        self.stores.put_many("p1", [make_stop()])
        self.repo.add(Visit(**form(), project_id="p1", stop_uid="u1"))
        self.assertEqual(self.stores.delete_all("p1"), 1)
        self.assertEqual(self.table.scan()["Items"], [])


class VisitServiceTests(unittest.TestCase):
    def setUp(self):
        self.projects = InMemoryProjectRepository()
        self.projects.put(Project(id="p1", name="P", pa="North PA", field_agent="Fay",
                                  project_type=ProjectType.OFFLINE))
        self.stores = InMemoryStoreRepository()
        self.stores.put_many("p1", [make_stop()])
        self.lists = ListService(InMemoryListRepository())
        self.service = VisitService(InMemoryVisitRepository(self.stores), self.stores, self.projects, self.lists)

    def test_snapshots_the_store_and_remembers_names(self):
        visit = self.service.create("p1", "u1", VisitInput.model_validate(form(category="power issues",
                                                                              subcategory="tv off")))
        self.assertEqual((visit.category, visit.subcategory), ("Power Issues", "TV Off"))  # canonical spelling
        self.assertEqual((visit.store_name, visit.addr), ("Awami Markaz", "1 Main St, Atlanta, GA, 30303"))
        self.assertEqual((visit.pa, visit.fa), ("North PA", "Fay"))  # project PA when the store has none
        self.assertEqual((visit.owner_name, visit.store_contact_name), ("Sam", "Lee"))
        self.assertEqual([e.value for e in self.lists.names(NameListKind.INSTALLERS).items], ["Ann"])
        self.assertEqual([e.value for e in self.lists.names(NameListKind.MANAGERS).items], ["Zoe"])
        self.assertEqual(self.service.list("p1", "u1").items, [visit])

    def test_rules(self):
        with self.assertRaises(ValidationFailed):  # not this store's stick
            self.service.create("p1", "u1", VisitInput.model_validate(form(screen_id="other")))
        with self.assertRaises(ValidationFailed):  # subcategory under another category
            self.service.create("p1", "u1", VisitInput.model_validate(form(subcategory="Removed")))
        with self.assertRaises(ValidationFailed):  # "replaced with" needs the new number
            self.service.create("p1", "u1", VisitInput.model_validate(
                form(category="Stick / Device Issues", subcategory="Stick Replaced With")))
        visit = self.service.create("p1", "u1", VisitInput.model_validate(
            form(category="Stick / Device Issues", subcategory="Stick Replaced With", replaced_with="ST-9")))
        self.assertEqual(visit.replaced_with, "ST-9")
        with self.assertRaises(NotFoundError):
            self.service.create("p1", "nope", VisitInput.model_validate(form()))
        with self.assertRaises(NotFoundError):
            self.service.list("nope", "u1")


class VisitsApiTests(unittest.TestCase):
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

    def test_create_and_list(self):
        response = self.client.post("/api/projects/p1/stores/u1/visits", json=form())
        self.assertEqual(response.status_code, 201, response.text)
        created = response.json()
        self.assertEqual((created["stick_number"], created["network_type"]), ("ST-1", "WiFi"))
        history = self.client.get("/api/projects/p1/stores/u1/visits").json()
        self.assertEqual([v["id"] for v in history["items"]], [created["id"]])
        stop = self.client.get("/api/projects/p1/stores/u1").json()
        self.assertEqual(list(stop["screen_visits"]), ["s1"])

    def test_errors(self):
        self.assertEqual(self.client.post("/api/projects/p1/stores/u1/visits", json=form(screen_id="x")).status_code,
                         422)
        bad = form()
        bad.pop("installer")
        self.assertEqual(self.client.post("/api/projects/p1/stores/u1/visits", json=bad).status_code, 422)
        self.assertEqual(self.client.post("/api/projects/p1/stores/zz/visits", json=form()).status_code, 404)
        self.assertEqual(self.client.get("/api/projects/p1/stores/u1/visits?cursor=%%%").status_code, 400)
