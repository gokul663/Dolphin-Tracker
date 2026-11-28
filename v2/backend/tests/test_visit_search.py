"""Log Visit's store search: by DD code (whole, any spelling, or part), stick number, or the store's words, across
every project but the all-venues list."""
import unittest

from fastapi.testclient import TestClient

from dolphin_tracker.api.app import create_app
from dolphin_tracker.api.deps import get_project_repository, get_store_repository
from dolphin_tracker.domain.models import Project, ProjectType, Screen, Stop
from dolphin_tracker.domain.venues import VENUES_PROJECT_ID
from dolphin_tracker.domain.visit_search import code_needle
from dolphin_tracker.repositories.memory import InMemoryProjectRepository, InMemoryStoreRepository


def store(uid: str, name: str, addr: str, *codes: str, ext: str = "", city: str = "Atlanta", sticks=()) -> Stop:
    screens = [Screen(id=f"{uid}-s{index}", venue_id=code, stick_number=(list(sticks) + [""] * 9)[index])
               for index, code in enumerate(codes or [""])]
    return Stop(uid=uid, store_name=name, addr=addr, city=city, state="GA", zip="30303", external_id=ext,
                screens=screens)


class VisitSearchTests(unittest.TestCase):
    def setUp(self):
        self.projects = InMemoryProjectRepository()
        self.projects.put(Project(id="p1", name="Alpha", project_type=ProjectType.OFFLINE))
        self.projects.put(Project(id="p2", name="Beta", project_type=ProjectType.OFFLINE))
        self.stores = InMemoryStoreRepository()
        self.stores.put_many("p1", [
            store("a1", "Joe's Market", "12 Main Street", "DD_ABC123", "DD-XYZ999", ext="EXT-77", sticks=("S-501",)),
            store("a2", "Corner Shop", "5 Oak Ave", "DD_QRS456"),
        ])
        self.stores.put_many("p2", [
            store("b1", "Main Deli", "40 Main St", "DD_ABC1234", city="Macon"),
        ])
        # The CMS data's all-venues list is not a project: never searched.
        self.stores.put_many(VENUES_PROJECT_ID, [store("v1", "Venue Main", "1 Main St", "DD_ABC123")])
        app = create_app()
        app.dependency_overrides[get_project_repository] = lambda: self.projects
        app.dependency_overrides[get_store_repository] = lambda: self.stores
        self.client = TestClient(app)

    def search(self, q: str, role: str = "operator", **params):
        response = self.client.get("/api/visit-search", params={"q": q, **params}, headers={"X-Dev-Role": role})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def uids(self, q: str, **params) -> list[str]:
        return [row["uid"] for row in self.search(q, **params)["items"]]

    def test_dd_code_in_any_spelling_exact_first(self):
        for q in ("DD_ABC123", "dd-abc123", " DD ABC123 ", "ddabc123"):
            with self.subTest(q=q):
                self.assertEqual(self.uids(q), ["a1", "b1"])  # the exact code first, then the longer one
        row = self.search("dd-abc123")["items"][0]
        self.assertEqual(row["matched_on"], ["dd_code"])
        self.assertEqual(row["matched_screen_ids"], ["a1-s0"])
        self.assertEqual(row["project_name"], "Alpha")
        self.assertEqual([s["venue_id"] for s in row["screens"]], ["DD_ABC123", "DD-XYZ999"])

    def test_part_of_a_code_and_a_stick_number(self):
        self.assertEqual(sorted(self.uids("ABC12")), ["a1", "b1"])
        self.assertEqual(self.uids("xyz99"), ["a1"])
        row = self.search("S-501")["items"][0]
        self.assertEqual((row["uid"], row["matched_on"], row["matched_screen_ids"]),
                         ("a1", ["stick_number"], ["a1-s0"]))

    def test_address_words_name_and_extid_across_projects(self):
        self.assertEqual(sorted(self.uids("main st")), ["a1", "b1"])  # "Street" and "St" are one word
        self.assertEqual(self.uids("40 Main Street Macon"), ["b1"])
        self.assertEqual(self.uids("joes"), ["a1"])
        self.assertEqual(self.uids("ext-77"), ["a1"])
        self.assertEqual(self.search("oak ave")["items"][0]["matched_on"], ["store"])
        self.assertEqual(self.uids("nowhere at all"), [])

    def test_limit_and_total(self):
        found = self.search("main", limit=1)
        self.assertEqual((len(found["items"]), found["total"]), (1, 2))

    def test_short_or_empty_queries_find_nothing(self):
        for q in ("", "a", "  m ", "--"):
            with self.subTest(q=q):
                self.assertEqual(self.search(q), {"items": [], "total": 0})
        self.assertEqual(code_needle("dd"), "")  # "DD" alone is in every code
        self.assertEqual(code_needle("12 Main Street Atlanta"), "")

    def test_who_may_search(self):
        for role, code in (("viewer", 403), ("technician", 403), ("operator", 200), ("admin", 200)):
            with self.subTest(role=role):
                response = self.client.get("/api/visit-search?q=main", headers={"X-Dev-Role": role})
                self.assertEqual(response.status_code, code)
