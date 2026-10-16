import tempfile
import unittest
from pathlib import Path

import boto3
from fastapi.testclient import TestClient
from moto import mock_aws

from dolphin_tracker.api.app import create_app
from dolphin_tracker.api.deps import get_file_store, get_job_repository, get_settings
from dolphin_tracker.config import Settings
from dolphin_tracker.domain.models import Job, JobStatus, JobType
from dolphin_tracker.repositories.files import (
    LocalFileStore,
    S3FileStore,
    make_file_store,
    result_key,
    upload_key,
)
from dolphin_tracker.repositories.memory import InMemoryJobRepository


class KeyLayoutTests(unittest.TestCase):
    def test_keys(self):
        self.assertEqual(upload_key("j1", "Sites (final).xlsx"), "uploads/j1/Sites_final_.xlsx")
        self.assertEqual(upload_key("j1", "../../etc/passwd"), "uploads/j1/passwd")
        self.assertEqual(upload_key("j1", ""), "uploads/j1/upload")
        self.assertEqual(result_key("j1"), "jobs/j1/result.json")

    def test_make_file_store_follows_bucket_setting(self):
        self.assertIsInstance(make_file_store(Settings(files_bucket="")), LocalFileStore)
        self.assertIsInstance(make_file_store(Settings(files_bucket="b")), S3FileStore)


class LocalFileStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = LocalFileStore(self.tmp.name)

    def test_bytes_and_json_roundtrip(self):
        key = upload_key("j1", "sites.csv")
        self.assertFalse(self.store.exists(key))
        self.store.put_bytes(key, b"address\n1 Main St\n")
        self.assertTrue(self.store.exists(key))
        self.assertEqual(self.store.get_bytes(key), b"address\n1 Main St\n")
        self.store.put_json(result_key("j1"), {"rows": [1, 2]})
        self.assertEqual(self.store.get_json(result_key("j1")), {"rows": [1, 2]})
        self.assertFalse(any(path.suffix == ".part" for path in Path(self.tmp.name).rglob("*")))

    def test_missing_file_raises(self):
        with self.assertRaises(FileNotFoundError):
            self.store.get_bytes("uploads/none/x.csv")

    def test_urls_point_at_local_routes(self):
        self.assertEqual(self.store.presign_upload(upload_key("j9", "a.csv"), "text/csv"), "/api/jobs/j9/upload")
        self.assertEqual(self.store.presign_download(result_key("j9")), "/api/jobs/j9/result")

    def test_keys_cannot_escape_root(self):
        with self.assertRaises(ValueError):
            self.store.put_bytes("../outside.txt", b"x")


class S3FileStoreTests(unittest.TestCase):
    def setUp(self):
        mock = mock_aws()
        mock.start()
        self.addCleanup(mock.stop)
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket="files")
        self.store = S3FileStore("files")  # default client, so the SigV4 config is under test

    def test_roundtrip_exists_and_presign(self):
        key = upload_key("j1", "sites.csv")
        self.assertFalse(self.store.exists(key))
        self.store.put_bytes(key, b"abc", content_type="text/csv")
        self.assertTrue(self.store.exists(key))
        self.assertEqual(self.store.get_bytes(key), b"abc")
        self.store.put_json(result_key("j1"), {"ok": True})
        self.assertEqual(self.store.get_json(result_key("j1")), {"ok": True})
        url = self.store.presign_upload(key, "text/csv")
        self.assertIn("files", url)
        self.assertIn("X-Amz-Signature", url)


class LocalUploadRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.jobs = InMemoryJobRepository()
        self.jobs.put(
            Job(id="j1", type=JobType.IMPORT_PARSE, payload={"upload_key": "uploads/j1/sites.csv"})
        )
        self.files = LocalFileStore(self.tmp.name)
        self.settings = Settings(app_env="test", max_upload_bytes=64)
        self.app = create_app()
        self.app.dependency_overrides[get_job_repository] = lambda: self.jobs
        self.app.dependency_overrides[get_file_store] = lambda: self.files
        self.app.dependency_overrides[get_settings] = lambda: self.settings
        self.client = TestClient(self.app)

    def test_put_stores_raw_body(self):
        response = self.client.put("/api/jobs/j1/upload", content=b"address\n1 Main St\n")
        self.assertEqual(response.status_code, 204)
        self.assertEqual(self.files.get_bytes("uploads/j1/sites.csv"), b"address\n1 Main St\n")

    def test_errors(self):
        self.assertEqual(self.client.put("/api/jobs/nope/upload", content=b"x").status_code, 404)
        self.assertEqual(self.client.put("/api/jobs/j1/upload", content=b"").status_code, 422)
        self.assertEqual(self.client.put("/api/jobs/j1/upload", content=b"x" * 65).status_code, 413)
        self.jobs.set_status("j1", JobStatus.RUNNING)
        self.assertEqual(self.client.put("/api/jobs/j1/upload", content=b"x").status_code, 409)

    def test_returns_404_when_files_live_in_s3(self):
        with mock_aws():
            self.app.dependency_overrides[get_file_store] = lambda: S3FileStore("files")
            self.assertEqual(self.client.put("/api/jobs/j1/upload", content=b"x").status_code, 404)
