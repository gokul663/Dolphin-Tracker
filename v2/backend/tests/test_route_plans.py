"""Route plans (ROUTE-PLANNER §3, §4, §7): day builder, repositories, store claims, service rules, store search, API."""
import unittest

import boto3
from fastapi.testclient import TestClient
from moto import mock_aws

from dolphin_tracker.api.app import create_app
from dolphin_tracker.api.deps import (
    get_list_repository,
    get_project_repository,
    get_route_plan_repository,
    get_store_repository,
    get_visit_repository,
)
from dolphin_tracker.domain.errors import ConflictError, NotFoundError, ValidationFailed
from dolphin_tracker.domain.lists import NameListKind
from dolphin_tracker.domain.models import Project, ProjectType, Screen, Stop
from dolphin_tracker.domain.route_plans import (
    NextDay,
    PlanDay,
    PlanInstaller,
    PlanStatus,
    PlanStop,
    PlanStoresAdd,
    Reassign,
    Replan,
    RoutePlan,
    RoutePlanCreate,
    RoutePlanUpdate,
    StartLocation,
    StoreRef,
    anchor_days,
    build_days,
    last_stop_starts,
    match_clusters,
)
from dolphin_tracker.domain.visits import VisitInput
from dolphin_tracker.repositories.dynamo import TABLE_DEFINITION
from dolphin_tracker.repositories.memory import (
    InMemoryListRepository,
    InMemoryProjectRepository,
    InMemoryRoutePlanRepository,
    InMemoryStoreRepository,
    InMemoryVisitRepository,
)
from dolphin_tracker.repositories.route_plans import DynamoRoutePlanRepository
from dolphin_tracker.repositories.stores import DynamoStoreRepository
from dolphin_tracker.services.lists import ListService
from dolphin_tracker.services.route_plans import RoutePlanService
from dolphin_tracker.services.store_search import PoolQuery, StoreSearchService
from dolphin_tracker.services.visits import VisitService

WEST = StartLocation(address="West depot", lat=33.75, lng=-85.0)
EAST = StartLocation(address="East depot", lat=33.75, lng=-83.0)


def row(key: str, lat: float, lng: float, state: str = "GA") -> dict:
    return {"id": key, "lat": lat, "lng": lng, "state": state}


def store(uid: str, lng: float, *, lat: float = 33.75, state: str = "GA", screens: int = 1,
          status: str = "Upcoming", city: str = "Atlanta") -> Stop:
    return Stop(uid=uid, store_name=f"Store {uid}", addr=f"{uid} Main St", city=city, state=state, lat=lat, lng=lng,
                screens=[Screen(id=f"{uid}-s{i}", status=status) for i in range(screens)])


class DayBuilderTests(unittest.TestCase):
    def test_clusters_go_to_the_nearest_start(self):
        west = [row("w1", 33.7, -85.1), row("w2", 33.8, -85.1)]
        east = [row("e1", 33.7, -82.9), row("e2", 33.8, -82.9)]
        starts = [{"lat": 33.75, "lng": -83.0}, {"lat": 33.75, "lng": -85.0}]  # east first, then west
        self.assertEqual(match_clusters([west, east], starts), [1, 0])
        self.assertEqual(match_clusters([west], starts), [None, 0])  # fewer clusters than starts

    def test_greedy_beyond_seven(self):
        clusters = [[row(f"c{i}", 30 + i, -84)] for i in range(8)]
        starts = [{"lat": 30 + i, "lng": -84} for i in reversed(range(8))]
        self.assertEqual(match_clusters(clusters, starts), list(reversed(range(8))))

    def test_first_day_starts_near_the_start(self):
        days = [[row("a", 33, -84), row("b", 33, -84.1)], [row("c", 33, -84.5), row("d", 33, -84.6)]]
        anchored = anchor_days(days, {"lat": 33, "lng": -84.7})  # the start is next to the far end
        self.assertEqual([[r["id"] for r in day] for day in anchored], [["d", "c"], ["b", "a"]])

    def test_build_respects_the_cap_and_places_rows_without_coordinates(self):
        rows = [row(f"w{i}", 33.7 + i * 0.01, -85.1) for i in range(7)]
        rows += [row(f"e{i}", 33.7 + i * 0.01, -82.9) for i in range(5)]
        rows.append({"id": "nogeo", "lat": None, "lng": None, "state": "GA"})
        routes = build_days(rows, {"West": {"lat": 33.75, "lng": -85.0}, "East": {"lat": 33.75, "lng": -83.0}}, 3)
        ids = {name: [r["id"] for day in days for r in day] for name, days in routes.items()}
        self.assertTrue(all(i.startswith("w") for i in ids["West"] if i != "nogeo"))
        self.assertTrue(all(i.startswith("e") for i in ids["East"] if i != "nogeo"))
        self.assertEqual(sorted(ids["West"] + ids["East"]), sorted(r["id"] for r in rows))
        for days in routes.values():
            self.assertTrue(all(len(day) <= 3 for day in days))

    def test_next_start_defaults_to_the_last_visited_stop(self):
        plan = RoutePlan(name="P", installers=[PlanInstaller(name="Ann", start=WEST)],
                         days=[PlanDay(number=1, date="2026-11-06", starts={"Ann": WEST})])
        stops = [
            PlanStop(project_id="p", stop_uid="a", store_name="A", addr="1 A St", lat=1, lng=1, screen_ids=["x"],
                     installer="Ann", day=1, seq=0, visited_screens=["x"]),
            PlanStop(project_id="p", stop_uid="b", store_name="B", lat=2, lng=2, screen_ids=["y"], installer="Ann",
                     day=1, seq=1),
        ]
        self.assertEqual(last_stop_starts(plan, stops)["Ann"], StartLocation(address="1 A St", lat=1, lng=1))
        self.assertEqual(last_stop_starts(plan, stops[1:])["Ann"], WEST)  # nothing visited yet: today's start


def make_plan(plan_id: str, created_at: str, status: PlanStatus = PlanStatus.ACTIVE) -> RoutePlan:
    return RoutePlan(id=plan_id, name=f"Plan {plan_id}", status=status, created_at=created_at,
                     installers=[PlanInstaller(name="Ann", start=WEST)],
                     days=[PlanDay(number=1, date="2026-11-06", starts={"Ann": WEST})])


class RoutePlanRepositoryContract:
    repo: object

    def test_plans_by_status_newest_first_and_versioned_updates(self):
        self.repo.put(make_plan("a", "2026-11-01"))
        self.repo.put(make_plan("b", "2026-11-02"))
        self.repo.put(make_plan("c", "2026-11-03", PlanStatus.CLOSED))
        self.assertEqual([p.id for p in self.repo.list(PlanStatus.ACTIVE).items], ["b", "a"])
        closed = self.repo.update("b", {"status": "closed"}, expected_version=1)
        self.assertEqual((closed.status, closed.version), (PlanStatus.CLOSED, 2))
        self.assertEqual([p.id for p in self.repo.list(PlanStatus.CLOSED).items], ["c", "b"])
        with self.assertRaises(ConflictError):
            self.repo.update("b", {"name": "x"}, expected_version=1)
        with self.assertRaises(NotFoundError):
            self.repo.update("zz", {"name": "x"})

    def test_stops_assignments_and_visits(self):
        stop = PlanStop(project_id="p1", stop_uid="u1", screen_ids=["s1", "s2"], lat=1.5, lng=2.5)
        self.repo.put_stops("plan", [stop, PlanStop(project_id="p1", stop_uid="u2")])
        self.assertEqual(self.repo.update_assignments("plan", [(stop.key, {"installer": "Ann", "day": 2, "seq": 1}),
                                                               ("p1#gone", {"day": 1})]), 1)
        with self.assertRaises(ValueError):
            self.repo.update_assignments("plan", [(stop.key, {"visited_screens": []})])
        self.repo.record_visit("plan", stop.key, "s1")
        again = self.repo.record_visit("plan", stop.key, "s1")  # once only
        self.assertEqual(again.visited_screens, ["s1"])
        self.assertIsNone(self.repo.record_visit("plan", "p1#gone", "s1"))
        loaded = self.repo.get_stop("plan", stop.key)
        self.assertEqual((loaded.installer, loaded.day, loaded.seq, loaded.lat), ("Ann", 2, 1, 1.5))
        self.repo.delete_stop("plan", "p1#u2")
        self.assertEqual([s.key for s in self.repo.list_stops("plan")], ["p1#u1"])


class InMemoryRoutePlanRepositoryTests(RoutePlanRepositoryContract, unittest.TestCase):
    def setUp(self):
        self.repo = InMemoryRoutePlanRepository()


class DynamoTestCase(unittest.TestCase):
    def setUp(self):
        mock = mock_aws()
        mock.start()
        self.addCleanup(mock.stop)
        resource = boto3.resource("dynamodb", region_name="us-east-1")
        self.table = resource.create_table(TableName="dolphin-tracker-test", **TABLE_DEFINITION)


class DynamoRoutePlanRepositoryTests(RoutePlanRepositoryContract, DynamoTestCase):
    def setUp(self):
        super().setUp()
        self.repo = DynamoRoutePlanRepository(self.table)


class StoreClaimContract:
    stores: object

    def test_one_active_plan_per_store(self):
        self.stores.put_many("p1", [store("a", -84), store("b", -84)])
        self.assertEqual(self.stores.claim_for_plan("p1", ["a", "b", "gone"], "plan1", "2026-11-06T00:00Z"),
                         ["a", "b"])
        self.assertEqual(self.stores.claim_for_plan("p1", ["a"], "plan2", "2026-11-07T00:00Z"), [])
        self.assertEqual(self.stores.release_from_plan("p1", ["a", "b"], "plan2"), 0)  # not theirs
        self.assertEqual(self.stores.release_from_plan("p1", ["a"], "plan1"), 1)
        a, b = self.stores.get("p1", "a"), self.stores.get("p1", "b")
        self.assertEqual((a.route_plan_id, a.last_planned_at), ("", "2026-11-06T00:00Z"))  # kept after release
        self.assertEqual(b.route_plan_id, "plan1")
        self.assertEqual(self.stores.claim_for_plan("p1", ["a"], "plan2", "2026-11-07T00:00Z"), ["a"])


class InMemoryStoreClaimTests(StoreClaimContract, unittest.TestCase):
    def setUp(self):
        self.stores = InMemoryStoreRepository()


class DynamoStoreClaimTests(StoreClaimContract, DynamoTestCase):
    def setUp(self):
        super().setUp()
        self.stores = DynamoStoreRepository(self.table)


def refs(*uids: str, project: str = "p1") -> list[StoreRef]:
    return [StoreRef(project_id=project, stop_uid=uid) for uid in uids]


class ServiceTestCase(unittest.TestCase):
    def setUp(self):
        self.projects = InMemoryProjectRepository()
        self.projects.put(Project(id="p1", name="Atlanta", project_type=ProjectType.OFFLINE))
        self.projects.put(Project(id="p2", name="Macon", project_type=ProjectType.OFFLINE))
        self.stores = InMemoryStoreRepository()
        self.stores.put_many("p1", [store(f"w{i}", -85.1 + i * 0.01) for i in range(4)]
                             + [store(f"e{i}", -82.9 - i * 0.01) for i in range(4)])
        self.stores.put_many("p2", [store("m0", -83.6, city="Macon"), store("m1", -83.61, city="Macon",
                                                                              status="Completed")])
        self.plans = InMemoryRoutePlanRepository()
        self.lists = ListService(InMemoryListRepository())
        self.service = RoutePlanService(self.plans, self.stores, self.projects, self.lists)

    def create(self, uids=None, per_day=2, **extra):
        uids = uids or [f"w{i}" for i in range(4)] + [f"e{i}" for i in range(4)]
        body = RoutePlanCreate(
            name="GA week", start_date="2026-11-06", stops_per_day=per_day,
            installers=[PlanInstaller(name="West", start=WEST), PlanInstaller(name="East", start=EAST)],
            stores=refs(*uids), **extra,
        )
        return self.service.create(body)

    def by_key(self, bundle):
        return {stop.key: stop for stop in bundle.stops}


class RoutePlanServiceTests(ServiceTestCase):
    def test_create_claims_stores_and_routes_from_each_start(self):
        result = self.create()
        bundle = result.bundle
        self.assertEqual((bundle.plan.store_count, bundle.plan.current_day), (8, 1))
        for stop in bundle.stops:
            self.assertEqual(stop.installer, "West" if stop.stop_uid.startswith("w") else "East")
            self.assertIn(stop.day, (1, 2))
        self.assertEqual(self.stores.get("p1", "w0").route_plan_id, bundle.plan.id)
        self.assertEqual(bundle.project_names, {"p1": "Atlanta"})
        self.assertEqual(bundle.store_status["p1#w0"], "Upcoming")
        self.assertEqual([e.value for e in self.lists.names(NameListKind.INSTALLERS).items], ["East", "West"])
        day1_west = [s for s in bundle.stops if s.installer == "West" and s.day == 1]
        self.assertEqual(len(day1_west), 2)

    def test_store_in_another_plan_is_skipped(self):
        first = self.create(["w0"])
        result = self.create(["w0", "w1"])
        self.assertEqual([(s.stop_uid, s.reason) for s in result.skipped], [("w0", "in_another_plan")])
        self.assertEqual(result.skipped[0].route_plan_id, first.bundle.plan.id)
        self.assertEqual([s.stop_uid for s in result.bundle.stops], ["w1"])
        with self.assertRaises(ValidationFailed):
            self.create(["w0"])  # nothing left to add

    def test_preview_claims_nothing(self):
        body = RoutePlanCreate(name="x", start_date="2026-11-06", installers=[PlanInstaller(name="A", start=WEST)],
                               stores=refs("w0", "w1"))
        preview = self.service.preview(body)
        self.assertEqual([s.day for s in preview.stops], [1, 1])
        self.assertEqual(self.stores.get("p1", "w0").route_plan_id, "")

    def test_duplicate_installers_refused(self):
        with self.assertRaises(ValidationFailed):
            self.service.create(RoutePlanCreate(
                name="x", start_date="2026-11-06", stores=refs("w0"),
                installers=[PlanInstaller(name="Ann", start=WEST), PlanInstaller(name="ann ", start=EAST)]))

    def test_next_day_rolls_unvisited_stops_and_keeps_visited_ones(self):
        bundle = self.create().bundle
        plan_id = bundle.plan.id
        today = [s for s in bundle.stops if s.installer == "West" and s.day == 1]
        visited, missed = today[0], today[1]
        self.service.record_visit(plan_id, "p1", visited.stop_uid, f"{visited.stop_uid}-s0")
        after = self.service.next_day(plan_id, NextDay(date="2026-11-07", version=bundle.plan.version))
        stops = self.by_key(after)
        self.assertEqual(after.plan.current_day, 2)
        self.assertEqual((stops[visited.key].day, stops[visited.key].installer), (1, "West"))  # history
        self.assertGreaterEqual(stops[missed.key].day, 2)  # back in the pool
        self.assertTrue(all(s.day >= 2 for s in after.stops if s.key != visited.key))
        # The new day's start defaulted to West's last visited stop.
        start = after.plan.days[-1].starts["West"]
        self.assertEqual((start.lat, start.lng), (visited.lat, visited.lng))
        with self.assertRaises(ValidationFailed):
            self.service.next_day(plan_id, NextDay(date="2026-11-07"))  # not after the current day
        with self.assertRaises(ConflictError):
            self.service.next_day(plan_id, NextDay(date="2026-11-08", version=1))  # stale

    def test_next_day_with_a_typed_start(self):
        bundle = self.create().bundle
        hotel = StartLocation(address="Hotel", lat=33.75, lng=-83.0)
        after = self.service.next_day(bundle.plan.id, NextDay(date="2026-11-09", starts={"West": hotel},
                                                              stops_per_day=4))
        self.assertEqual(after.plan.days[-1].starts["West"], hotel)
        self.assertEqual(after.plan.stops_per_day, 4)
        with self.assertRaises(ValidationFailed):
            self.service.next_day(bundle.plan.id, NextDay(date="2026-11-10", starts={"Nobody": hotel}))

    def test_add_stores_go_to_the_forecast(self):
        bundle = self.create(["w0", "w1", "e0", "e1"]).bundle
        result = self.service.add_stores(bundle.plan.id, PlanStoresAdd(stores=refs("w2", "w0") + refs("m0",
                                                                                                     project="p2")))
        stops = self.by_key(result.bundle)
        self.assertEqual([(s.stop_uid, s.reason) for s in result.skipped], [("w0", "already_in_plan")])
        self.assertGreaterEqual(stops["p1#w2"].day, 2)
        self.assertGreaterEqual(stops["p2#m0"].day, 2)
        self.assertEqual(result.bundle.plan.store_count, 6)
        self.assertEqual(result.bundle.project_names, {"p1": "Atlanta", "p2": "Macon"})
        today = self.service.add_stores(bundle.plan.id, PlanStoresAdd(stores=refs("w3"), replan=Replan.TODAY))
        self.assertEqual(len(today.bundle.stops), 7)

    def test_remove_reassign_and_close(self):
        bundle = self.create().bundle
        plan_id = bundle.plan.id
        west_day1 = [s for s in bundle.stops if s.installer == "West" and s.day == 1]
        moved = self.service.reassign(plan_id, "p1", west_day1[0].stop_uid, Reassign(installer="east"))
        self.assertEqual(self.by_key(moved)[west_day1[0].key].installer, "East")
        with self.assertRaises(NotFoundError):
            self.service.reassign(plan_id, "p1", "w1", Reassign(installer="Nobody"))
        removed = self.service.remove_stop(plan_id, "p1", west_day1[1].stop_uid)
        self.assertNotIn(west_day1[1].key, self.by_key(removed))
        self.assertEqual(self.stores.get("p1", west_day1[1].stop_uid).route_plan_id, "")
        self.service.record_visit(plan_id, "p1", "e0", "e0-s0")
        with self.assertRaises(ConflictError):
            self.service.remove_stop(plan_id, "p1", "e0")  # visited stops are history
        closed = self.service.close(plan_id)
        self.assertEqual(closed.plan.status, PlanStatus.CLOSED)
        self.assertTrue(all(self.stores.get("p1", s.stop_uid).route_plan_id == "" for s in closed.stops))
        with self.assertRaises(ConflictError):
            self.service.next_day(plan_id, NextDay(date="2026-11-08"))

    def test_update_installers(self):
        bundle = self.create().bundle
        only_west = [PlanInstaller(name="West", start=WEST)]
        with self.assertRaises(ValidationFailed):  # East has stops today
            self.service.update(bundle.plan.id, RoutePlanUpdate(installers=only_west))
        after = self.service.update(bundle.plan.id, RoutePlanUpdate(installers=only_west, replan=Replan.TODAY,
                                                                    name="Renamed"))
        self.assertEqual(after.plan.name, "Renamed")
        self.assertEqual({s.installer for s in after.stops}, {"West"})


class VisitPlanLinkTests(ServiceTestCase):
    def test_a_visit_marks_the_plan_stop(self):
        bundle = self.create(["w0"]).bundle
        visits = VisitService(InMemoryVisitRepository(self.stores), self.stores, self.projects, self.lists,
                              self.service)
        body = VisitInput(screen_id="w0-s0", visit_date="2026-11-06", dd_code="DD", venue_name="V", stick_number="S",
                          installer="West", dolphin_manager="Zoe", network_type="LTE", latest_apk=True,
                          kiosk_mode=True, category="Other", subcategory="New screen Added")
        visit = visits.create("p1", "w0", body)
        self.assertEqual((visit.route_plan_id, visit.plan_day), (bundle.plan.id, 1))
        stop = self.plans.get_stop(bundle.plan.id, "p1#w0")
        self.assertEqual(stop.visited_screens, ["w0-s0"])
        self.service.close(bundle.plan.id)
        later = visits.create("p1", "w0", body)  # no plan any more
        self.assertEqual((later.route_plan_id, later.plan_day), ("", None))


class StoreSearchTests(ServiceTestCase):
    def setUp(self):
        super().setUp()
        self.search = StoreSearchService(self.projects, self.stores)

    def test_filters_and_paging(self):
        everything = self.search.search(PoolQuery(), limit=4)
        self.assertEqual(len(everything.items), 4)
        rest = self.search.search(PoolQuery(), limit=10, cursor=everything.next_cursor)
        self.assertEqual(len(rest.items), 6)
        macon = self.search.pins(PoolQuery(city=["macon"], pending_only=True))
        self.assertEqual([(s.project_name, s.uid) for s in macon], [("Macon", "m0")])
        self.create(["w0"])
        self.assertNotIn("w0", {s.uid for s in self.search.pins(PoolQuery(available_only=True))})
        self.assertEqual({s.uid for s in self.search.pins(PoolQuery(q="w0 main"))}, {"w0"})

    def test_facets_ignore_their_own_filter(self):
        facets = self.search.facets(PoolQuery(city=["Macon"]))
        self.assertEqual([c["value"] for c in facets["cities"]], ["Atlanta", "Macon"])
        self.assertEqual(facets["states"], [{"value": "GA", "count": 2}])
        self.assertEqual(facets["projects"], [{"value": "p2", "label": "Macon", "count": 2}])


class RoutePlansApiTests(ServiceTestCase):
    def setUp(self):
        super().setUp()
        lists = InMemoryListRepository()
        app = create_app()
        app.dependency_overrides[get_project_repository] = lambda: self.projects
        app.dependency_overrides[get_store_repository] = lambda: self.stores
        app.dependency_overrides[get_route_plan_repository] = lambda: self.plans
        app.dependency_overrides[get_list_repository] = lambda: lists
        app.dependency_overrides[get_visit_repository] = lambda: InMemoryVisitRepository(self.stores)
        self.client = TestClient(app)

    def body(self, *uids):
        return {
            "name": "GA", "start_date": "2026-11-06", "stops_per_day": 3,
            "installers": [{"name": "West", "start": WEST.model_dump()}, {"name": "East", "start": EAST.model_dump()}],
            "stores": [{"project_id": "p1", "stop_uid": uid} for uid in uids],
        }

    def test_flow(self):
        self.assertEqual(self.client.post("/api/route-plans/preview", json=self.body("w0")).status_code, 200)
        created = self.client.post("/api/route-plans", json=self.body("w0", "e0", "e1"))
        self.assertEqual(created.status_code, 201, created.text)
        plan = created.json()["bundle"]["plan"]
        listed = self.client.get("/api/route-plans").json()
        self.assertEqual([p["id"] for p in listed["items"]], [plan["id"]])
        bundle = self.client.get(f"/api/route-plans/{plan['id']}").json()
        self.assertEqual(set(bundle["next_starts"]), {"West", "East"})
        moved = self.client.post(f"/api/route-plans/{plan['id']}/stops/p1/w0/reassign", json={"installer": "East"})
        self.assertEqual(moved.status_code, 200, moved.text)
        nxt = self.client.post(f"/api/route-plans/{plan['id']}/next-day", json={"date": "2026-11-07"})
        self.assertEqual(nxt.json()["plan"]["days"][-1]["number"], 2)
        added = self.client.post(f"/api/route-plans/{plan['id']}/stores",
                                 json={"stores": [{"project_id": "p2", "stop_uid": "m0"}]})
        self.assertEqual(added.status_code, 200, added.text)
        self.assertEqual(self.client.delete(f"/api/route-plans/{plan['id']}/stops/p2/m0").status_code, 200)
        patched = self.client.patch(f"/api/route-plans/{plan['id']}", json={"name": "GA 2", "replan": "none"})
        self.assertEqual(patched.json()["plan"]["name"], "GA 2")
        self.assertEqual(self.client.post(f"/api/route-plans/{plan['id']}/close").json()["plan"]["status"], "closed")
        self.assertEqual(self.client.get("/api/route-plans?status=closed").json()["items"][0]["id"], plan["id"])

    def test_search_endpoints_and_errors(self):
        page = self.client.get("/api/store-search?state=GA&limit=2").json()
        self.assertEqual(len(page["items"]), 2)
        self.assertEqual(len(self.client.get("/api/store-search/pins?project_id=p2").json()), 2)
        self.assertEqual(self.client.get("/api/store-search/facets").json()["states"][0]["value"], "GA")
        self.assertEqual(self.client.get("/api/store-search?cursor=%%").status_code, 400)
        self.assertEqual(self.client.get("/api/route-plans/nope").status_code, 404)
        self.assertEqual(self.client.post("/api/route-plans", json={**self.body("w0"), "installers": []}).status_code,
                         422)
