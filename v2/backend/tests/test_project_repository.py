import unittest

import boto3
from moto import mock_aws

from dolphin_tracker.domain.cursors import encode_cursor
from dolphin_tracker.domain.errors import ConflictError, NotFoundError
from dolphin_tracker.domain.models import Project, ProjectType, RoutingStatus
from dolphin_tracker.repositories.dynamo import TABLE_DEFINITION
from dolphin_tracker.repositories.projects import DynamoProjectRepository


def make_project(project_id: str, created_at: str) -> Project:
    return Project(
        id=project_id,
        name=f"Project {project_id}",
        project_type=ProjectType.NEW_INSTALLATION,
        installers=["A", "B"],
        pa_percentage=40.5,
        stops_per_day=25,
        created_at=created_at,
        updated_at=created_at,
    )


@mock_aws
class DynamoProjectRepositoryTests(unittest.TestCase):
    def setUp(self):
        resource = boto3.resource("dynamodb", region_name="us-east-1")
        self.table = resource.create_table(TableName="dolphin-tracker-test", **TABLE_DEFINITION)
        self.repo = DynamoProjectRepository(self.table)

    def test_put_get_roundtrip_preserves_floats_and_ints(self):
        self.repo.put(make_project("p1", "2026-10-01T00:00:00+00:00"))
        loaded = self.repo.get("p1")
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded.pa_percentage, 40.5)
        self.assertEqual(loaded.stops_per_day, 25)
        self.assertEqual(loaded.installers, ["A", "B"])
        self.assertIsNone(self.repo.get("missing"))

    def test_list_is_newest_first_and_paginates_with_cursor(self):
        for index in range(3):
            self.repo.put(make_project(f"p{index}", f"2026-10-0{index + 1}T00:00:00+00:00"))
        first = self.repo.list(limit=2)
        self.assertEqual([p.id for p in first.items], ["p2", "p1"])
        self.assertIsNotNone(first.next_cursor)
        second = self.repo.list(limit=2, cursor=first.next_cursor)
        self.assertEqual([p.id for p in second.items], ["p0"])
        self.assertIsNone(second.next_cursor)

    def test_cursor_dynamodb_rejects_is_a_value_error(self):
        self.repo.put(make_project("p1", "2026-10-01T00:00:00+00:00"))
        with self.assertRaisesRegex(ValueError, "Invalid cursor"):
            self.repo.list(cursor=encode_cursor({"offset": 3}))  # a dict, but not this index's key
        with self.assertRaisesRegex(ValueError, "Invalid cursor"):
            self.repo.list(cursor=encode_cursor({"PK": "PROJECT#p1", "SK": "META"}))  # table key, not GSI1 key

    def test_update_bumps_version_and_fences_on_expected_version(self):
        self.repo.put(make_project("p1", "2026-10-01T00:00:00+00:00"))
        updated = self.repo.update("p1", {"name": "Renamed", "stops_per_day": 30}, expected_version=1)
        self.assertEqual(updated.name, "Renamed")
        self.assertEqual(updated.stops_per_day, 30)
        self.assertEqual(updated.version, 2)
        with self.assertRaises(ConflictError):
            self.repo.update("p1", {"name": "Stale"}, expected_version=1)
        with self.assertRaises(NotFoundError):
            self.repo.update("missing", {"name": "x"})

    def test_delete(self):
        self.repo.put(make_project("p1", "2026-10-01T00:00:00+00:00"))
        self.repo.delete("p1")
        self.assertIsNone(self.repo.get("p1"))

    def test_begin_routing_fences_concurrent_builds(self):
        self.repo.put(make_project("p1", "2026-10-01T00:00:00+00:00"))
        long_ago = "2026-01-01T00:00:00+00:00"
        claimed = self.repo.begin_routing("p1", "job-a", stale_before=long_ago)
        self.assertEqual((claimed.routing_status, claimed.routing_job_id), (RoutingStatus.BUILDING, "job-a"))
        with self.assertRaises(ConflictError):
            self.repo.begin_routing("p1", "job-b", stale_before=long_ago)
        with self.assertRaises(NotFoundError):
            self.repo.begin_routing("missing", "job-c", stale_before=long_ago)

    def test_begin_routing_appends_an_installer_to_the_current_list(self):
        self.repo.put(make_project("p1", "2026-10-01T00:00:00+00:00"))
        long_ago = "2026-01-01T00:00:00+00:00"
        self.repo.update("p1", {"installers": ["Ann", "Bob"]})  # a rename landed after the caller read the list
        claimed = self.repo.begin_routing("p1", "job-a", stale_before=long_ago, add_installer="Cy")
        self.assertEqual(claimed.installers, ["Ann", "Bob", "Cy"])
        self.repo.finish_routing("p1", "job-a", RoutingStatus.READY)
        with self.assertRaisesRegex(ConflictError, "already exists"):
            self.repo.begin_routing("p1", "job-b", stale_before=long_ago, add_installer="Cy")
        self.assertEqual(self.repo.get("p1").routing_job_id, "")  # the failed claim changed nothing

    def test_stale_build_can_be_taken_over(self):
        self.repo.put(make_project("p1", "2026-10-01T00:00:00+00:00"))
        self.repo.begin_routing("p1", "job-a", stale_before="2026-01-01T00:00:00+00:00")
        far_future = "2999-01-01T00:00:00+00:00"  # everything is older than this, so job-a counts as stale
        self.assertEqual(self.repo.begin_routing("p1", "job-b", stale_before=far_future).routing_job_id, "job-b")

    def test_finish_routing_only_for_the_slot_holder(self):
        self.repo.put(make_project("p1", "2026-10-01T00:00:00+00:00"))
        self.repo.begin_routing("p1", "job-a", stale_before="2026-01-01T00:00:00+00:00")
        self.assertFalse(self.repo.finish_routing("p1", "job-old", RoutingStatus.READY))
        self.assertEqual(self.repo.get("p1").routing_status, RoutingStatus.BUILDING)
        self.assertTrue(self.repo.finish_routing("p1", "job-a", RoutingStatus.READY))
        project = self.repo.get("p1")
        self.assertEqual((project.routing_status, project.routing_job_id), (RoutingStatus.READY, ""))
        self.assertFalse(self.repo.finish_routing("p1", "job-a", RoutingStatus.FAILED))  # already released
