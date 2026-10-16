import json
import threading
import unittest
from datetime import datetime

import boto3
from moto import mock_aws

from dolphin_tracker.config import Settings
from dolphin_tracker.domain.errors import NotFoundError
from dolphin_tracker.domain.models import Job, JobStatus, JobType
from dolphin_tracker.repositories.dynamo import TABLE_DEFINITION
from dolphin_tracker.repositories.jobs import DynamoJobRepository
from dolphin_tracker.repositories.memory import InMemoryJobRepository
from dolphin_tracker.services.worker_invoker import InlineInvoker, LambdaInvoker, make_invoker

CREATED = "2026-10-16T12:00:00+00:00"


def make_job(job_id: str = "j1") -> Job:
    return Job(
        id=job_id, type=JobType.IMPORT_PARSE, project_id="p1", payload={"upload_key": "uploads/j1/sites.csv"},
        created_at=CREATED, updated_at=CREATED,
    )


class JobRepositoryContract:
    repo: object

    def test_put_get(self):
        self.repo.put(make_job())
        job = self.repo.get("j1")
        self.assertEqual(job.status, JobStatus.QUEUED)
        self.assertEqual(job.payload, {"upload_key": "uploads/j1/sites.csv"})
        self.assertIsNone(self.repo.get("missing"))

    def test_status_transitions_and_progress_clamp(self):
        self.repo.put(make_job())
        running = self.repo.set_status("j1", JobStatus.RUNNING, progress=140, message="Geocoding")
        self.assertEqual((running.status, running.progress, running.message), (JobStatus.RUNNING, 100, "Geocoding"))
        self.assertGreater(running.updated_at, CREATED)
        kept = self.repo.set_status("j1", JobStatus.RUNNING, message="still")
        self.assertEqual(kept.progress, 100)  # progress omitted -> unchanged
        failed = self.repo.set_status("j1", JobStatus.FAILED, message="boom")
        self.assertEqual((failed.status, failed.message), (JobStatus.FAILED, "boom"))

    def test_set_result(self):
        self.repo.put(make_job())
        done = self.repo.set_result("j1", "jobs/j1/result.json", message="120 rows")
        self.assertEqual(
            (done.status, done.progress, done.result_key, done.message),
            (JobStatus.SUCCEEDED, 100, "jobs/j1/result.json", "120 rows"),
        )
        self.assertEqual(self.repo.get("j1").result_key, "jobs/j1/result.json")

    def test_updates_on_missing_job_raise(self):
        with self.assertRaises(NotFoundError):
            self.repo.set_status("nope", JobStatus.RUNNING)
        with self.assertRaises(NotFoundError):
            self.repo.set_result("nope", None)


class DynamoJobRepositoryTests(JobRepositoryContract, unittest.TestCase):
    def setUp(self):
        mock = mock_aws()
        mock.start()
        self.addCleanup(mock.stop)
        self.table = boto3.resource("dynamodb", region_name="us-east-1").create_table(
            TableName="dolphin-tracker-test", **TABLE_DEFINITION
        )
        self.repo = DynamoJobRepository(self.table)

    def test_item_has_ttl_24h_after_creation(self):
        self.repo.put(make_job())
        item = self.table.get_item(Key={"PK": "JOB#j1", "SK": "META"})["Item"]
        self.assertEqual(item["entity"], "JOB")
        expected = int(datetime.fromisoformat(CREATED).timestamp()) + 24 * 3600
        self.assertEqual(int(item["ttl"]), expected)
        self.assertNotIn("GSI1PK", item)  # jobs stay out of the project list index


class InMemoryJobRepositoryTests(JobRepositoryContract, unittest.TestCase):
    def setUp(self):
        self.repo = InMemoryJobRepository()

    def test_history_records_transitions(self):
        self.repo.put(make_job())
        self.repo.set_status("j1", JobStatus.RUNNING, progress=10)
        self.repo.set_status("j1", JobStatus.RUNNING, progress=20)
        self.repo.set_result("j1", None)
        self.assertEqual(self.repo.history["j1"], [JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.SUCCEEDED])


class FakeLambdaClient:
    def __init__(self):
        self.calls = []

    def invoke(self, **kwargs):
        self.calls.append(kwargs)
        return {"StatusCode": 202}


class InvokerTests(unittest.TestCase):
    EVENT = {"job_id": "j1", "job_type": "import_parse", "project_id": None}

    def test_lambda_invoker_sends_async_event(self):
        client = FakeLambdaClient()
        LambdaInvoker("worker-fn", client=client).invoke(self.EVENT)
        (call,) = client.calls
        self.assertEqual(call["FunctionName"], "worker-fn")
        self.assertEqual(call["InvocationType"], "Event")
        self.assertEqual(json.loads(call["Payload"]), self.EVENT)

    def test_lambda_invoker_needs_a_function_name(self):
        client = FakeLambdaClient()
        invoker = LambdaInvoker("", client=client)  # constructing is fine; enqueueing is what fails
        with self.assertRaises(ValueError):
            invoker.invoke(self.EVENT)
        self.assertEqual(client.calls, [])

    def test_inline_invoker_runs_on_another_thread(self):
        seen = []
        invoker = InlineInvoker(lambda event: seen.append((event, threading.current_thread().name)))
        invoker.invoke(self.EVENT)
        invoker.wait()
        self.assertEqual(seen, [(self.EVENT, "job-j1")])

    def test_inline_invoker_swallows_crashes(self):
        def boom(_event):
            raise RuntimeError("worker crashed")

        invoker = InlineInvoker(boom)
        invoker.invoke(self.EVENT)
        invoker.wait()  # no exception escapes the thread

    def test_make_invoker_follows_worker_mode(self):
        self.assertIsInstance(make_invoker(Settings(worker_mode="inline")), InlineInvoker)
        lambda_invoker = make_invoker(Settings(worker_mode="lambda", worker_function_name="fn"))
        self.assertIsInstance(lambda_invoker, LambdaInvoker)
