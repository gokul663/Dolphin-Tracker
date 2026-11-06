import unittest

import boto3
from fastapi.testclient import TestClient
from moto import mock_aws

from dolphin_tracker.api.app import create_app
from dolphin_tracker.api.deps import get_project_repository, get_store_repository
from dolphin_tracker.domain.kpi import KPI_ATTRIBUTES, kpi_summary
from dolphin_tracker.domain.models import Project, ProjectType, Screen, Stop
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
    stop("a", "Completed", "1 Main St", dma="ATL", venue_type="Bar"),
    stop("b", "Completed", "1 MAIN ST.", dma="ATL", venue_type="Bar"),  # same address as a, all complete
    stop("c", "Upcoming", "2 Oak St", installer="Bo", dma="ATL"),
    stop("d", "Completed", "2 Oak St", installer="Bo", installer_name="Bobby"),  # same address as c, mixed
    stop("e", "Offline", "", installer=""),  # blank street, same city/state/zip as f
    stop("f", "Archived", "", installer=""),
]


class KpiSummaryTests(unittest.TestCase):
    def test_matches_v1_rules(self):
        kpi = kpi_summary(s.model_dump(mode="json") for s in STOPS)
        self.assertEqual((kpi.total, kpi.complete, kpi.pending, kpi.offline, kpi.other), (6, 3, 1, 1, 1))
        self.assertEqual(
            kpi.by_status,
            {"Upcoming": 1, "Invitation Email Sent": 0, "Shipped": 0, "Delivered": 0, "Serviced - Needs More Work": 0,
             "Completed": 3, "Offline": 1, "Archived": 1, "Cancelled": 0},
        )
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
        self.assertEqual(kpi.by_status["Completed"], 0)

    def test_pending_set_and_legacy_values(self):
        rows = [{"uid": str(i), "status": status} for i, status in enumerate(
            ["Upcoming", "Invitation Email Sent", "Shipped", "Delivered", "Cancelled", "Incomplete", "Complete"]
        )]
        kpi = kpi_summary(rows)  # v1 values (the migration's parity side) read through the legacy map
        self.assertEqual((kpi.pending, kpi.complete, kpi.other), (5, 1, 1))


class KpiV2Tests(unittest.TestCase):
    def test_screens_and_committed_vs_actual(self):
        stops = [
            Stop(uid="a", store_name="a", addr="1", committed_dolphin_screens=3, committed_store_tvs=1,
                 screens=[Screen(status="Completed"), Screen(status="Shipped"),
                          Screen(status="Completed", is_dolphin_screen=False)]),
            Stop(uid="b", store_name="b", addr="2", committed_dolphin_screens=None,
                 screens=[Screen(status="Offline")]),
            Stop(uid="c", store_name="c", addr="3", screens=[Screen(status="Cancelled")]),
        ]
        kpi = kpi_summary(stop.model_dump(mode="json") for stop in stops)
        self.assertEqual((kpi.total, kpi.pending, kpi.complete, kpi.offline, kpi.other), (3, 1, 0, 1, 1))
        self.assertEqual(kpi.by_status["Shipped"], 1)  # a: least-progressed screen
        self.assertEqual(kpi.screens_total, 5)
        self.assertEqual({k: v for k, v in kpi.screens_by_status.items() if v},
                         {"Completed": 2, "Shipped": 1, "Offline": 1, "Cancelled": 1})
        self.assertEqual((kpi.committed_dolphin_screens, kpi.committed_store_tvs), (3, 1))
        self.assertEqual((kpi.actual_dolphin_screens, kpi.actual_store_tvs), (4, 1))

    def test_project_detail_carries_kpis(self):
        projects, stores = InMemoryProjectRepository(), InMemoryStoreRepository()
        projects.put(Project(id="p1", name="One", project_type=ProjectType.OFFLINE))
        stores.put_many("p1", STOPS)
        app = create_app()
        app.dependency_overrides[get_project_repository] = lambda: projects
        app.dependency_overrides[get_store_repository] = lambda: stores
        body = TestClient(app).get("/api/projects/p1").json()
        self.assertEqual((body["name"], body["kpi"]["total"], body["kpi"]["screens_total"]), ("One", 6, 6))


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
