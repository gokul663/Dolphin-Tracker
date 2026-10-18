import tempfile
import unittest

from fastapi.testclient import TestClient

from dolphin_tracker.api.app import create_app
from dolphin_tracker.api.deps import (
    get_file_store,
    get_job_repository,
    get_project_repository,
    get_store_repository,
    get_worker_invoker,
)
from dolphin_tracker.handlers.worker import WorkerDeps, dispatch
from dolphin_tracker.repositories.files import LocalFileStore
from dolphin_tracker.repositories.memory import (
    InMemoryJobRepository,
    InMemoryProjectRepository,
    InMemoryStoreRepository,
)
from dolphin_tracker.repositories.worker_invoker import InlineInvoker
from tests.fakes import FakeGeocoder


class NoopInvoker:
    def invoke(self, event):
        pass


def stop_input(i: int, **extra) -> dict:
    return {
        "external_id": f"IBC-{i}", "store_name": f"Store {i}", "addr": f"{i} Main St", "city": "Atlanta",
        "state": "GA", "zip": "30303",
        "lat": 33.70 + i * 0.01, "lng": -84.40 + i * 0.01, "fields": {"dma": "ATL"}, **extra,
    }


def project_body(**overrides) -> dict:
    body = {
        "name": " Atlanta refresh ", "pa": "North", "project_type": "new_installation", "installers": ["Ann", "Bo"],
        "pa_percentage": 40, "dolphin_percentage": 60, "stops_per_day": 4,
        "stops": [stop_input(i) for i in range(10)],
    }
    body.update(overrides)
    return body


class ProjectApiTestCase(unittest.TestCase):
    """App wired to in-memory repositories, with routing jobs run inline through the real worker dispatch."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.projects = InMemoryProjectRepository()
        self.stores = InMemoryStoreRepository()
        self.jobs = InMemoryJobRepository()
        self.files = LocalFileStore(self.tmp.name)
        self.geocoder = FakeGeocoder()
        deps = WorkerDeps(self.jobs, self.projects, self.stores, self.files, lambda: self.geocoder)
        self.invoker = InlineInvoker(lambda event: dispatch(event, deps))
        self.app = create_app()
        overrides = {
            get_project_repository: lambda: self.projects,
            get_store_repository: lambda: self.stores,
            get_job_repository: lambda: self.jobs,
            get_file_store: lambda: self.files,
            get_worker_invoker: lambda: self.invoker,
        }
        self.app.dependency_overrides.update(overrides)
        self.client = TestClient(self.app)

    def create_project(self, **overrides) -> dict:
        response = self.client.post("/api/projects", json=project_body(**overrides))
        self.assertIn(response.status_code, (201, 202), response.text)
        self.invoker.wait()
        return response.json()


class CreateProjectApiTests(ProjectApiTestCase):
    def test_create_skips_duplicates_and_requires_an_ibc(self):
        stops = [stop_input(0), {**stop_input(1), "external_id": "ibc-0"}, {**stop_input(2), "addr": "0 MAIN ST."}]
        body = self.create_project(stops=stops)
        self.assertEqual([(s["index"], s["reason"]) for s in body["skipped"]], [(1, "external_id"), (2, "address")])
        self.assertEqual(body["project"]["stop_count"], 1)
        missing = self.client.post("/api/projects", json=project_body(stops=[{**stop_input(0), "external_id": " "}]))
        self.assertEqual(missing.status_code, 422)
        self.assertEqual(missing.json()["detail"]["stops"][0]["errors"], ["IBC# is required"])

    def test_create_saves_the_import_mapping_and_store_details(self):
        stop = {**stop_input(0), "external_id": " ibc-7 ", "dma": "ATL", "spot_visible": True,
                "screens": [{"stick_number": "S1"}, {"stick_number": "S2", "status": "Shipped"}]}
        created = self.create_project(stops=[stop], import_mapping={"ibc": "external_id", "x": "bogus"})
        project = self.projects.get(created["project"]["id"])
        self.assertEqual(project.import_mappings, {"ibc": "external_id"})
        (saved,) = self.stores.list_all(project.id)
        self.assertEqual((saved.external_id, saved.dma, saved.spot_visible), ("IBC-7", "ATL", True))
        self.assertEqual([(s.stick_number, s.status) for s in saved.screens], [("S1", "Upcoming"), ("S2", "Shipped")])
        self.assertEqual(saved.status, "Upcoming")  # derived: the least-progressed screen

    def test_create_with_stops_returns_202_and_routes_on_the_worker(self):
        response = self.client.post("/api/projects", json=project_body())
        self.assertEqual(response.status_code, 202, response.text)
        body = response.json()
        project, job_id = body["project"], body["job_id"]
        self.assertEqual(project["name"], "Atlanta refresh")
        self.assertEqual((project["routing_status"], project["routing_job_id"]), ("building", job_id))
        self.assertEqual(project["stop_count"], 10)
        self.assertEqual([field["key"] for field in project["field_schema"]][:3], ["pa", "venue_type", "dma"])
        self.invoker.wait()

        job = self.client.get(f"/api/jobs/{job_id}").json()
        self.assertEqual((job["type"], job["status"], job["payload"]["mode"]), ("routing_build", "succeeded", "create"))
        project = self.client.get(f"/api/projects/{project['id']}").json()
        self.assertEqual((project["routing_status"], project["routing_job_id"]), ("ready", ""))

        bundle = self.client.get(f"/api/projects/{project['id']}/routes").json()
        self.assertEqual(bundle["installers"], ["Ann", "Bo"])
        self.assertEqual(bundle["stops_per_day"], 4)
        stops = [stop for days in bundle["routes"].values() for day in days for stop in day]
        self.assertEqual(len(stops), 10)
        self.assertTrue(all(len(day) <= 4 for days in bundle["routes"].values() for day in days))
        self.assertEqual(sorted(stop["display_id"] for stop in stops), sorted(f"S{i}" for i in range(1, 11)))
        self.assertEqual(sum(stat["total"] for stat in bundle["stats"].values()), 10)

    def test_minted_stop_fields(self):
        self.app.dependency_overrides[get_worker_invoker] = lambda: NoopInvoker()  # inspect stops before routing
        body = project_body(stops=[stop_input(0, initial_status="Completed"), stop_input(1)])
        project = self.client.post("/api/projects", json=body).json()["project"]
        stops = sorted(self.stores.list_all(project["id"]), key=lambda stop: stop.seq)
        minted = [(s.display_id, s.seq, s.day, s.installer) for s in stops]
        self.assertEqual(minted, [("S1", 0, 1, ""), ("S2", 1, 1, "")])
        self.assertEqual([s.status.value for s in stops], ["Completed", "Upcoming"])
        self.assertEqual(len({s.uid for s in stops}), 2)

    def test_create_without_stops_returns_201_and_no_job(self):
        response = self.client.post("/api/projects", json=project_body(stops=[]))
        self.assertEqual(response.status_code, 201)
        body = response.json()
        self.assertIsNone(body["job_id"])
        self.assertEqual(body["project"]["routing_status"], "ready")
        self.assertEqual(self.invoker._threads, [])

    def test_validation_lists_every_bad_row(self):
        stops = [
            stop_input(0),
            stop_input(1, store_name=" "),
            stop_input(2, addr="", fields={"owner_email": "nope"}),
            stop_input(3, fields={"mystery": "x"}),
        ]
        response = self.client.post("/api/projects", json=project_body(stops=stops, installers=["A", "A"]))
        self.assertEqual(response.status_code, 422)
        detail = response.json()["detail"]
        self.assertEqual(detail["errors"], ["Duplicate installer names: A"])
        self.assertEqual([row["index"] for row in detail["stops"]], [1, 2, 3])
        self.assertEqual(detail["stops"][1]["errors"], ["Address is required", "Owner Email: enter a valid email"])
        self.assertIn("3 stop(s)", detail["message"])
        self.assertEqual(self.projects.list().items, [])

    def test_pydantic_bounds(self):
        for overrides in ({"stops_per_day": 51}, {"pa_percentage": 101}, {"installers": []}, {"project_type": "x"}):
            response = self.client.post("/api/projects", json=project_body(**overrides))
            self.assertEqual(response.status_code, 422, overrides)

    def test_custom_field_schema(self):
        schema = [{"key": "screens", "label": "Screens", "type": "number", "required": True}]
        bad = self.client.post("/api/projects", json=project_body(field_schema=schema))
        self.assertEqual(bad.status_code, 422)  # stops carry dma, which is not in this schema, and lack screens
        stops = [stop_input(0, fields={"screens": "3"})]
        project = self.create_project(field_schema=schema, stops=stops)["project"]
        self.assertEqual(self.stores.list_all(project["id"])[0].fields, {"screens": 3})

    def test_routes_404_for_unknown_project(self):
        self.assertEqual(self.client.get("/api/projects/nope/routes").status_code, 404)
