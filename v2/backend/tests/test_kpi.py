import unittest

import boto3
from fastapi.testclient import TestClient
from moto import mock_aws

from dolphin_tracker.api.app import create_app
from dolphin_tracker.api.deps import get_project_repository, get_store_repository
from dolphin_tracker.domain.kpi import KPI_ATTRIBUTES, kpi_summary
from dolphin_tracker.domain.models import Project, ProjectType, Stop
from dolphin_tracker.repositories.dynamo import TABLE_DEFINITION
from dolphin_tracker.repositories.memory import InMemoryProjectRepository, InMemoryStoreRepository
from dolphin_tracker.repositories.projects import DynamoProjectRepository
from dolphin_tracker.repositories.stores import DynamoStoreRepository
from dolphin_tracker.services.projects import ProjectService


def stop(uid: str, status: str, addr: str, *, installer: str = "Ann", installer_name: str = "", **fields) -> Stop:
    return Stop(
        uid=uid, store_name=uid, addr=addr, city="Atlanta", state="GA", zip="30303", status=status,
        installer=installer, installer_name=installer_name, fields=fields,
    )


STOPS = [
    stop("a", "Complete", "1 Main St", dma="ATL", venue_type="Bar"),
    stop("b", "Complete", "1 MAIN ST.", dma="ATL", venue_type="Bar"),  # same address as a, all complete
    stop("c", "Incomplete", "2 Oak St", installer="Bo", dma="ATL"),
    stop("d", "Complete", "2 Oak St", installer="Bo", installer_name="Bobby"),  # same address as c, mixed
    stop("e", "Technical Issue", "", installer=""),  # blank street, same city/state/zip as f
    stop("f", "Other", "", installer=""),
]


class KpiSummaryTests(unittest.TestCase):
    def test_matches_v1_rules(self):
        kpi = kpi_summary(s.model_dump(mode="json") for s in STOPS)
        self.assertEqual((kpi.total, kpi.complete, kpi.pending, kpi.technical, kpi.other), (6, 3, 1, 1, 1))
        self.assertEqual(kpi.by_status, {"Complete": 3, "Incomplete": 1, "Technical Issue": 1, "Other": 1})
        self.assertEqual(kpi.by_installer, {"Ann": 2, "Bo": 1, "Bobby": 1})  # installer_name wins
        self.assertEqual(kpi.by_dma["ATL"].model_dump(), {"total": 3, "complete": 2, "pending": 1})
        self.assertEqual(kpi.by_dma["Not provided"].model_dump(), {"total": 3, "complete": 1, "pending": 0})
        self.assertEqual(kpi.by_venue_type["Bar"].total, 2)
        # Unique addresses (v1 key: normalised addr|city|state|zip): {1 main st} complete, {2 oak st} mixed, and
        # e + f share "atlanta|ga|30303" because their street is blank: 3 groups, 1 complete.
        self.assertEqual(kpi.address_status.model_dump(), {"total": 3, "complete": 1, "pending": 2})

    def test_empty_project(self):
        kpi = kpi_summary([])
        self.assertEqual((kpi.total, kpi.address_status.total), (0, 0))
        self.assertEqual(kpi.by_status["Complete"], 0)


class ProjectListKpiDynamoTests(unittest.TestCase):
    def setUp(self):
        mock = mock_aws()
        mock.start()
        self.addCleanup(mock.stop)
        table = boto3.resource("dynamodb", region_name="us-east-1").create_table(
            TableName="dolphin-tracker-test", **TABLE_DEFINITION
        )
        self.projects = DynamoProjectRepository(table)
        self.stores = DynamoStoreRepository(table)

    def test_projected_query_and_two_project_fan_out(self):
        self.projects.put(Project(id="p1", name="One", project_type=ProjectType.OFFLINE, created_at="2026-10-01"))
        self.projects.put(Project(id="p2", name="Two", project_type=ProjectType.OFFLINE, created_at="2026-10-02"))
        self.stores.put_many("p1", STOPS)
        self.stores.put_many("p2", [stop("z", "Complete", "9 Elm St")])

        rows = self.stores.list_projected("p1", KPI_ATTRIBUTES)
        self.assertEqual(len(rows), 6)
        self.assertTrue(all(set(row) <= set(KPI_ATTRIBUTES) for row in rows))
        self.assertNotIn("lat", rows[0])

        page = ProjectService(self.projects, self.stores).list(limit=10)
        by_id = {summary.id: summary.kpi for summary in page.items}
        self.assertEqual([summary.id for summary in page.items], ["p2", "p1"])
        self.assertEqual((by_id["p1"].total, by_id["p1"].complete, by_id["p1"].address_status.total), (6, 3, 3))
        self.assertEqual((by_id["p2"].total, by_id["p2"].complete), (1, 1))


class ProjectListKpiApiTests(unittest.TestCase):
    def test_list_includes_kpi(self):
        projects, stores = InMemoryProjectRepository(), InMemoryStoreRepository()
        projects.put(Project(id="p1", name="One", project_type=ProjectType.OFFLINE))
        stores.put_many("p1", STOPS)
        app = create_app()
        app.dependency_overrides[get_project_repository] = lambda: projects
        app.dependency_overrides[get_store_repository] = lambda: stores
        body = TestClient(app).get("/api/projects").json()
        kpi = body["items"][0]["kpi"]
        self.assertEqual((kpi["total"], kpi["complete"], kpi["pending"]), (6, 3, 1))
        self.assertEqual(kpi["by_dma"]["ATL"], {"total": 3, "complete": 2, "pending": 1})
        self.assertEqual(kpi["address_status"], {"total": 3, "complete": 1, "pending": 2})
