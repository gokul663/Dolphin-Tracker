import tempfile
import unittest

from fastapi.testclient import TestClient

from dolphin_tracker.api.app import create_app
from dolphin_tracker.api.deps import (
    get_file_store,
    get_job_repository,
    get_project_repository,
    get_worker_invoker,
)
from dolphin_tracker.domain.models import Project, ProjectType
from dolphin_tracker.handlers.worker import WorkerDeps, dispatch
from dolphin_tracker.repositories.files import LocalFileStore
from dolphin_tracker.repositories.memory import (
    InMemoryJobRepository,
    InMemoryProjectRepository,
    InMemoryStoreRepository,
)
from dolphin_tracker.repositories.worker_invoker import InlineInvoker
from tests.fakes import FakeGeocoder, geocode_ok

CSV = b"Store Name,Address,PA\nStore A,1 Main St,North\nStore B,,North\n"


class FailingInvoker:
    def invoke(self, event):
        raise ConnectionError("lambda unreachable")


class ImportJobFlowTests(unittest.TestCase):
    """The browser flow in local mode: create → PUT upload → start → poll → fetch result."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.jobs = InMemoryJobRepository()
        self.projects = InMemoryProjectRepository()
        self.projects.put(Project(id="p1", name="P", project_type=ProjectType.OFFLINE))
        self.files = LocalFileStore(self.tmp.name)
        self.geocoder = FakeGeocoder(geocodes={"1 Main St": geocode_ok("1 Main St")})
        deps = WorkerDeps(
            jobs=self.jobs, projects=self.projects, stores=InMemoryStoreRepository(), files=self.files,
            geocoder_factory=lambda: self.geocoder,
        )
        self.invoker = InlineInvoker(lambda event: dispatch(event, deps))
        self.app = create_app()
        self.app.dependency_overrides[get_job_repository] = lambda: self.jobs
        self.app.dependency_overrides[get_project_repository] = lambda: self.projects
        self.app.dependency_overrides[get_file_store] = lambda: self.files
        self.app.dependency_overrides[get_worker_invoker] = lambda: self.invoker
        self.client = TestClient(self.app)

    def _create(self, **body) -> dict:
        payload = {"filename": "sites.csv", "content_type": "text/csv", **body}
        response = self.client.post("/api/jobs/imports", json=payload)
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def test_full_flow(self):
        created = self._create()
        job_id = created["job_id"]
        self.assertEqual(created["upload_url"], f"/api/jobs/{job_id}/upload")
        self.assertEqual(created["upload_key"], f"uploads/{job_id}/sites.csv")
        self.assertEqual(self.client.get(f"/api/jobs/{job_id}").json()["status"], "queued")

        self.assertEqual(self.client.put(created["upload_url"], content=CSV).status_code, 204)
        started = self.client.post(f"/api/jobs/{job_id}/start")
        self.assertEqual(started.status_code, 202)
        self.assertEqual(started.json()["status"], "running")
        self.invoker.wait()

        job = self.client.get(f"/api/jobs/{job_id}").json()
        self.assertEqual((job["status"], job["progress"]), ("succeeded", 100))
        self.assertEqual(job["result_url"], f"/api/jobs/{job_id}/result")
        result = self.client.get(job["result_url"]).json()
        self.assertEqual(result["summary"], {"total": 2, "valid": 1, "needs_review": 0, "invalid": 1})
        self.assertEqual(result["rows"][0]["addr"], "1 Main St")

    def test_create_validation(self):
        bad = self.client.post("/api/jobs/imports", json={"filename": "sites.xls"})
        self.assertEqual(bad.status_code, 422)
        self.assertEqual(self.client.post("/api/jobs/imports", json={"filename": ""}).status_code, 422)
        missing = self.client.post("/api/jobs/imports", json={"filename": "a.csv", "project_id": "nope"})
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(self._create(project_id="p1")["upload_key"].split("/")[-1], "sites.csv")

    def test_start_requires_the_upload_and_only_runs_once(self):
        job_id = self._create()["job_id"]
        self.assertEqual(self.client.post(f"/api/jobs/{job_id}/start").status_code, 409)
        self.client.put(f"/api/jobs/{job_id}/upload", content=CSV)
        self.assertEqual(self.client.post(f"/api/jobs/{job_id}/start").status_code, 202)
        self.assertEqual(self.client.post(f"/api/jobs/{job_id}/start").status_code, 409)
        self.invoker.wait()
        self.assertEqual(self.client.put(f"/api/jobs/{job_id}/upload", content=CSV).status_code, 409)

    def test_result_is_404_until_succeeded_and_for_unknown_jobs(self):
        job_id = self._create()["job_id"]
        self.assertEqual(self.client.get(f"/api/jobs/{job_id}/result").status_code, 404)
        self.assertIsNone(self.client.get(f"/api/jobs/{job_id}").json()["result_url"])
        self.assertEqual(self.client.get("/api/jobs/nope").status_code, 404)
        self.assertEqual(self.client.post("/api/jobs/nope/start").status_code, 404)

    def test_worker_invoke_failure_marks_job_failed(self):
        self.app.dependency_overrides[get_worker_invoker] = lambda: FailingInvoker()
        job_id = self._create()["job_id"]
        self.client.put(f"/api/jobs/{job_id}/upload", content=CSV)
        self.assertEqual(self.client.post(f"/api/jobs/{job_id}/start").status_code, 503)
        job = self.client.get(f"/api/jobs/{job_id}").json()
        self.assertEqual((job["status"], job["message"]), ("failed", "Could not start the worker"))

    def test_failed_import_reports_message(self):
        job_id = self._create()["job_id"]
        self.client.put(f"/api/jobs/{job_id}/upload", content=b"name\nno address column\n")
        self.client.post(f"/api/jobs/{job_id}/start")
        self.invoker.wait()
        job = self.client.get(f"/api/jobs/{job_id}").json()
        self.assertEqual((job["status"], job["message"]), ("failed", "Missing 'address' column"))


class WorkerDispatchTests(unittest.TestCase):
    def test_unknown_job_type(self):
        self.assertEqual(dispatch({"job_id": "j", "job_type": "nope"})["ok"], False)
        self.assertEqual(dispatch({"job_id": "j"})["error"], "unknown job_type")
