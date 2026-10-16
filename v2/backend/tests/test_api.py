import unittest

from fastapi.testclient import TestClient

from dolphin_tracker.api.app import create_app
from dolphin_tracker.api.deps import get_db_probe, get_project_repository, get_store_repository
from dolphin_tracker.domain.models import Project, ProjectType
from dolphin_tracker.repositories.memory import InMemoryProjectRepository, InMemoryStoreRepository


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.app = create_app()
        self.projects = InMemoryProjectRepository()
        self.app.dependency_overrides[get_project_repository] = lambda: self.projects
        self.stores = InMemoryStoreRepository()
        self.app.dependency_overrides[get_store_repository] = lambda: self.stores
        self.app.dependency_overrides[get_db_probe] = lambda: (lambda: True)
        self.client = TestClient(self.app)

    def _seed(self, count: int) -> None:
        for index in range(count):
            self.projects.put(
                Project(
                    id=f"p{index}",
                    name=f"Project {index}",
                    project_type=ProjectType.OFFLINE,
                    created_at=f"2026-10-{index + 1:02d}T00:00:00+00:00",
                )
            )

    def test_root_and_health(self):
        self.assertEqual(self.client.get("/api").json()["message"], "Dolphin Tracker API")
        body = self.client.get("/api/health").json()
        self.assertEqual(body["status"], "ok")
        self.assertTrue(body["db"])
        self.assertEqual(body["env"], "test")

    def test_list_projects_paginates(self):
        self._seed(3)
        first = self.client.get("/api/projects", params={"limit": 2}).json()
        self.assertEqual([p["id"] for p in first["items"]], ["p2", "p1"])
        second = self.client.get("/api/projects", params={"limit": 2, "cursor": first["next_cursor"]}).json()
        self.assertEqual([p["id"] for p in second["items"]], ["p0"])
        self.assertIsNone(second["next_cursor"])

    def test_bad_cursor_and_limit_are_rejected(self):
        self.assertEqual(self.client.get("/api/projects", params={"cursor": "!!"}).status_code, 400)
        self.assertEqual(self.client.get("/api/projects", params={"limit": 500}).status_code, 422)

    def test_get_project(self):
        self._seed(1)
        self.assertEqual(self.client.get("/api/projects/p0").json()["name"], "Project 0")
        self.assertEqual(self.client.get("/api/projects/nope").status_code, 404)

    def test_openapi_is_served_under_api(self):
        self.assertEqual(self.client.get("/api/openapi.json").status_code, 200)
