"""Pick lists (ROUTE-PLANNER §2, §5): domain tree, repositories, service, API."""
import unittest

import boto3
from fastapi.testclient import TestClient
from moto import mock_aws

from dolphin_tracker.api.app import create_app
from dolphin_tracker.api.deps import get_list_repository
from dolphin_tracker.domain.errors import ValidationFailed
from dolphin_tracker.domain.lists import (
    DEFAULT_CATEGORIES,
    REPLACED_WITH_SUBCATEGORIES,
    Category,
    NameListKind,
    find_subcategory,
)
from dolphin_tracker.repositories.dynamo import TABLE_DEFINITION
from dolphin_tracker.repositories.lists import DynamoListRepository
from dolphin_tracker.repositories.memory import InMemoryListRepository
from dolphin_tracker.services.lists import ListService

PORTAL_CATEGORIES = [
    "Network Issues", "Power Issues", "Stick / Device Issues", "Display Issues", "Configuration", "Other",
    "Store Issues", "Removal", "Issue Not Resolved (Follow-up Required)",
]


class DefaultTreeTests(unittest.TestCase):
    def test_portal_categories_hold_all_48_reasons_once(self):
        # The portal's nine, after our own "New Installation" (an install visit is not an offline fix).
        self.assertEqual(DEFAULT_CATEGORIES[0][0], "New Installation")
        portal = DEFAULT_CATEGORIES[1:]
        self.assertEqual(sorted(name for name, _ in portal), sorted(PORTAL_CATEGORIES))
        reasons = [sub for _, subs in portal for sub in subs]
        self.assertEqual(len(reasons), 48)
        self.assertEqual(len(set(reasons)), 48)
        self.assertLessEqual(REPLACED_WITH_SUBCATEGORIES, set(reasons))

    def test_find_subcategory_returns_the_canonical_spelling(self):
        tree = [Category(name="Power Issues", subcategories=["TV Off", "Turned off"])]
        self.assertEqual(find_subcategory(tree, "power  issues", "tv off"), ("Power Issues", "TV Off"))
        self.assertIsNone(find_subcategory(tree, "Power Issues", "Removed"))
        self.assertIsNone(find_subcategory(tree, "Nope", "TV Off"))

    def test_subcategories_unique_within_a_category(self):
        with self.assertRaises(ValueError):
            Category(name="X", subcategories=["A", "a "])


class ListRepositoryContract:
    repo: object

    def test_names_are_idempotent_and_alphabetical(self):
        first = self.repo.add_name(NameListKind.MANAGERS, "Zoe Park")
        again = self.repo.add_name(NameListKind.MANAGERS, "zoe   park")
        self.assertEqual(again.value, "Zoe Park")  # the stored spelling wins
        self.assertEqual(again.created_at, first.created_at)
        self.repo.add_name(NameListKind.MANAGERS, "adam")
        self.repo.add_name(NameListKind.INSTALLERS, "Ann")
        page = self.repo.list_names(NameListKind.MANAGERS)
        self.assertEqual([entry.value for entry in page.items], ["adam", "Zoe Park"])
        self.assertEqual([e.value for e in self.repo.list_names(NameListKind.INSTALLERS).items], ["Ann"])

    def test_paging_and_delete(self):
        for name in ("a", "b", "c"):
            self.repo.add_name(NameListKind.INSTALLERS, name)
        first = self.repo.list_names(NameListKind.INSTALLERS, limit=2)
        self.assertEqual([entry.value for entry in first.items], ["a", "b"])
        rest = self.repo.list_names(NameListKind.INSTALLERS, limit=2, cursor=first.next_cursor)
        self.assertEqual([entry.value for entry in rest.items], ["c"])
        self.repo.delete_name(NameListKind.INSTALLERS, "B")
        self.assertEqual([e.value for e in self.repo.list_names(NameListKind.INSTALLERS).items], ["a", "c"])

    def test_entry_details_are_saved_over_a_typed_name(self):
        from dolphin_tracker.domain.lists import NameEntry
        typed = self.repo.add_name(NameListKind.INSTALLERS, "Sai")  # typed on a visit: no details yet
        details = NameEntry(value="sai", phone="555 010 2000", email="sai@example.com", shipping_address="1 Elm St")
        saved = self.repo.save_entry(NameListKind.INSTALLERS, details)
        self.assertEqual(saved.created_at, typed.created_at)
        listed = self.repo.list_names(NameListKind.INSTALLERS).items
        self.assertEqual([(e.phone, e.email, e.shipping_address) for e in listed],
                         [("555 010 2000", "sai@example.com", "1 Elm St")])
        self.assertIsNone(self.repo.save_entry(NameListKind.INSTALLERS, details, must_be_new=True))

    def test_categories_roundtrip(self):
        self.assertIsNone(self.repo.get_categories())
        tree = [Category(name="Power Issues", subcategories=["TV Off"])]
        self.repo.put_categories(tree)
        self.assertEqual(self.repo.get_categories(), tree)


class InMemoryListRepositoryTests(ListRepositoryContract, unittest.TestCase):
    def setUp(self):
        self.repo = InMemoryListRepository()


class DynamoListRepositoryTests(ListRepositoryContract, unittest.TestCase):
    def setUp(self):
        mock = mock_aws()
        mock.start()
        self.addCleanup(mock.stop)
        resource = boto3.resource("dynamodb", region_name="us-east-1")
        self.table = resource.create_table(TableName="dolphin-tracker-test", **TABLE_DEFINITION)
        self.repo = DynamoListRepository(self.table)

    def test_item_layout(self):
        self.repo.add_name(NameListKind.MANAGERS, "Zoe  Park")
        item = self.table.get_item(Key={"PK": "LIST#managers", "SK": "ITEM#zoe park"})["Item"]
        self.assertEqual((item["entity"], item["value"]), ("LIST_ITEM", "Zoe Park"))


class ListServiceTests(unittest.TestCase):
    def setUp(self):
        self.service = ListService(InMemoryListRepository())

    def test_defaults_until_saved(self):
        self.assertEqual(len(self.service.categories()), 10)
        saved = self.service.replace_categories([Category(name=" Power  Issues ", subcategories=["TV Off"])])
        self.assertEqual(saved[0].name, "Power Issues")
        # A saved tree without "New Installation" still offers it, first.
        self.assertEqual([c.name for c in self.service.categories()], ["New Installation", "Power Issues"])

    def test_tree_rules(self):
        with self.assertRaises(ValidationFailed):
            self.service.replace_categories([])
        with self.assertRaises(ValidationFailed):
            self.service.replace_categories([Category(name="A"), Category(name="a")])

    def test_resolve_category(self):
        self.assertEqual(self.service.resolve_category("removal", "removed"), ("Removal", "Removed"))
        with self.assertRaises(ValidationFailed):
            self.service.resolve_category("Removal", "TV Off")

    def test_blank_names(self):
        with self.assertRaises(ValidationFailed):
            self.service.add_name(NameListKind.INSTALLERS, "   ")
        self.service.remember(NameListKind.INSTALLERS, "  ")  # ignored, no error
        self.service.remember(NameListKind.INSTALLERS, " Ann ")
        self.assertEqual([e.value for e in self.service.names(NameListKind.INSTALLERS).items], ["Ann"])


class ListsApiTests(unittest.TestCase):
    def setUp(self):
        self.repo = InMemoryListRepository()
        app = create_app()
        app.dependency_overrides[get_list_repository] = lambda: self.repo
        self.client = TestClient(app)

    def test_names(self):
        self.assertEqual(self.client.post("/api/lists/managers", json={"value": "Zoe"}).json()["value"], "Zoe")
        self.client.post("/api/lists/managers", json={"value": "zoe"})
        body = self.client.get("/api/lists/managers").json()
        self.assertEqual(([e["value"] for e in body["items"]], body["next_cursor"]), (["Zoe"], None))
        self.assertEqual(self.client.delete("/api/lists/managers/ZOE").status_code, 204)
        self.assertEqual(self.client.get("/api/lists/managers").json()["items"], [])
        self.assertEqual(self.client.get("/api/lists/nope").status_code, 422)
        self.assertEqual(self.client.post("/api/lists/installers", json={"value": "  "}).status_code, 422)

    def test_installer_details(self):
        url = "/api/lists/installers/Sai%20Kumar"
        missing = self.client.put(url, json={"email": "nope"})
        self.assertEqual(missing.status_code, 422)
        self.assertEqual(set(missing.json()["detail"]["fields"]), {"phone", "email"})
        saved = self.client.put(url, json={"phone": "(555) 010-2000", "email": "sai@example.com",
                                           "shipping_address": "1 Elm St,  Macon GA", "must_be_new": True})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["shipping_address"], "1 Elm St, Macon GA")
        self.assertEqual(self.client.put(url, json={"phone": "5550102000", "must_be_new": True}).status_code, 422)
        self.assertEqual(self.client.put(url, json={"phone": "5550109999"}).json()["phone"], "5550109999")  # an edit
        # No phone: only when asked to, and it lists with a blank phone (flagged on the page).
        self.assertEqual(self.client.put("/api/lists/installers/Bo", json={}).status_code, 422)
        self.assertEqual(self.client.put("/api/lists/installers/Bo", json={"allow_no_phone": True}).status_code, 200)
        listed = self.client.get("/api/lists/installers").json()["items"]
        self.assertEqual([(item["value"], item["phone"]) for item in listed], [("Bo", ""), ("Sai Kumar", "5550109999")])

    def test_categories(self):
        tree = self.client.get("/api/lists/categories").json()
        self.assertEqual(len(tree), 10)
        tree = {"categories": [{"name": "A", "subcategories": ["x"]}]}
        response = self.client.put("/api/lists/categories", json=tree)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get("/api/lists/categories").json()[-1], {"name": "A", "subcategories": ["x"]})
        self.assertEqual(self.client.put("/api/lists/categories", json={"categories": []}).status_code, 422)
