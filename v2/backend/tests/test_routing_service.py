import unittest

from dolphin_tracker.domain.errors import ConflictError
from dolphin_tracker.domain.models import (
    Job,
    JobStatus,
    Project,
    ProjectType,
    RoutingStatus,
    ScreenStatus,
    Stop,
)
from dolphin_tracker.repositories.memory import (
    InMemoryJobRepository,
    InMemoryProjectRepository,
    InMemoryStoreRepository,
)
from dolphin_tracker.services.routing import SUPERSEDED, RoutingService, day_miles, group_routes
from tests.fakes import status_write


def make_stops(count: int) -> list[Stop]:
    return [
        Stop(
            uid=f"u{i:02d}", display_id=f"S{i + 1}", store_name=f"Store {i}", addr=f"{i} Main St", state="GA",
            lat=33.3 + i * 0.01, lng=-84.5 + i * 0.013, seq=i,
        )
        for i in range(count)
    ]


class RecordingInvoker:
    def __init__(self):
        self.events = []

    def invoke(self, event):
        self.events.append(event)


class FailingInvoker:
    def invoke(self, event):
        raise ConnectionError("down")


class RoutingHelperTests(unittest.TestCase):
    def test_build_assignments_covers_every_stop_and_respects_per_day(self):
        stops = make_stops(23)
        assignments = RoutingService.build_assignments(stops, ["A", "B"], per_day=6)
        self.assertEqual(set(assignments), {stop.uid for stop in stops})
        per_day_counts: dict[tuple[str, int], int] = {}
        for installer, day, _ in assignments.values():
            per_day_counts[(installer, day)] = per_day_counts.get((installer, day), 0) + 1
        self.assertTrue(all(count <= 6 for count in per_day_counts.values()))
        for (installer, day), count in per_day_counts.items():
            seqs = sorted(seq for i, d, seq in assignments.values() if (i, d) == (installer, day))
            self.assertEqual(seqs, list(range(count)))

    def test_diff_reports_only_changed_stops(self):
        stops = make_stops(3)
        stops[0].installer, stops[0].day, stops[0].seq = "A", 1, 0
        assignments = {"u00": ("A", 1, 0), "u01": ("B", 1, 0), "u02": ("B", 1, 1)}
        changes = dict(RoutingService.diff(stops, assignments))
        self.assertEqual(set(changes), {"u01", "u02"})
        self.assertEqual(changes["u02"], {"installer": "B", "day": 1, "seq": 1})

    def test_stops_without_coordinates_are_still_assigned(self):
        stops = make_stops(4)
        stops[3].lat = stops[3].lng = None
        assignments = RoutingService.build_assignments(stops, ["A"], per_day=8)
        self.assertIn("u03", assignments)

    def test_group_routes_orders_days_and_seq_and_collapses_gaps(self):
        stops = make_stops(4)
        for stop, (installer, day, seq) in zip(
            stops, [("A", 3, 1), ("A", 3, 0), ("A", 1, 0), ("ghost", 1, 0)], strict=True
        ):
            stop.installer, stop.day, stop.seq = installer, day, seq
        routes = group_routes(stops, ["A", "B"])
        self.assertEqual([[s.uid for s in day] for day in routes["A"]], [["u02"], ["u01", "u00"]])
        self.assertEqual(routes["B"], [])
        self.assertNotIn("ghost", routes)

    def test_day_miles_skips_stops_without_coordinates(self):
        stops = make_stops(3)
        stops[1].lat = None
        self.assertAlmostEqual(day_miles(stops), day_miles([stops[0], stops[2]]))
        self.assertEqual(day_miles([]), 0)


class RoutingBuildTests(unittest.TestCase):
    def setUp(self):
        self.projects = InMemoryProjectRepository()
        self.stores = InMemoryStoreRepository()
        self.jobs = InMemoryJobRepository()
        self.invoker = RecordingInvoker()
        self.service = RoutingService(self.projects, self.stores, self.jobs, self.invoker)
        project = Project(id="p1", name="P", project_type=ProjectType.OFFLINE, installers=["A", "B"], stops_per_day=5)
        self.projects.put(project)
        self.stores.put_many("p1", make_stops(20))

    def _enqueue(self, mode="recluster") -> str:
        return self.service.enqueue("p1", mode).id

    def test_enqueue_claims_slot_and_invokes_worker(self):
        job_id = self._enqueue()
        project = self.projects.get("p1")
        self.assertEqual((project.routing_status, project.routing_job_id), (RoutingStatus.BUILDING, job_id))
        (event,) = self.invoker.events
        expected = {"job_id": job_id, "job_type": "routing_build", "project_id": "p1", "mode": "recluster"}
        self.assertEqual(event, expected)

    def test_second_enqueue_conflicts_and_records_failed_job(self):
        self._enqueue()
        with self.assertRaises(ConflictError):
            self._enqueue()
        failed = [job for job in self.jobs._items.values() if job.status == JobStatus.FAILED]
        self.assertEqual(len(failed), 1)
        self.assertEqual(len(self.invoker.events), 1)

    def test_invoke_failure_releases_slot_as_failed(self):
        service = RoutingService(self.projects, self.stores, self.jobs, FailingInvoker())
        with self.assertRaises(RuntimeError):
            service.enqueue("p1", "recluster")
        project = self.projects.get("p1")
        self.assertEqual((project.routing_status, project.routing_job_id), (RoutingStatus.FAILED, ""))

    def test_unknown_mode_is_rejected_before_any_write(self):
        with self.assertRaises(ValueError):
            self.service.enqueue("p1", "teleport")
        self.assertEqual(self.projects.get("p1").routing_status, RoutingStatus.READY)

    def test_build_writes_routes_and_releases_slot(self):
        self.stores.update_fields("p1", "u03", status_write(ScreenStatus.COMPLETED, comment="done"))
        self.stores.update_fields("p1", "u04", {"route_stale": True})
        job_id = self._enqueue()
        self.service.run_build(job_id)

        job = self.jobs.get(job_id)
        self.assertEqual(job.status, JobStatus.SUCCEEDED, job.message)
        self.assertEqual(self.jobs.history[job_id], [JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.SUCCEEDED])
        project = self.projects.get("p1")
        self.assertEqual((project.routing_status, project.routing_job_id), (RoutingStatus.READY, ""))
        stops = self.stores.list_all("p1")
        self.assertTrue(all(stop.installer in {"A", "B"} for stop in stops))
        days: dict[tuple[str, int], int] = {}
        for stop in stops:
            days[(stop.installer, stop.day)] = days.get((stop.installer, stop.day), 0) + 1
        self.assertTrue(all(count <= 5 for count in days.values()))
        kept = self.stores.get("p1", "u03")
        self.assertEqual((kept.status, kept.comment), (ScreenStatus.COMPLETED, "done"))  # progress preserved
        self.assertFalse(self.stores.get("p1", "u04").route_stale)

    def test_redelivered_event_after_success_is_a_no_op(self):
        job_id = self._enqueue()
        self.service.run_build(job_id)
        def layout():
            return {stop.uid: (stop.installer, stop.day, stop.seq) for stop in self.stores.list_all("p1")}

        before = layout()
        self.service.run_build(job_id)  # Lambda async invoke is at-least-once
        self.assertEqual(self.jobs.history[job_id], [JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.SUCCEEDED])
        self.assertEqual(self.jobs.get(job_id).status, JobStatus.SUCCEEDED)
        self.assertEqual(before, layout())

    def test_redelivered_event_after_failure_stays_failed(self):
        job_id = self._enqueue()
        self.service.build_assignments = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("boom"))
        self.service.run_build(job_id)
        message = self.jobs.get(job_id).message
        self.service.run_build(job_id)
        self.assertEqual(self.jobs.history[job_id], [JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.FAILED])
        self.assertEqual(self.jobs.get(job_id).message, message)

    def test_rerun_is_idempotent(self):
        job_id = self._enqueue()
        self.service.run_build(job_id)
        first = {stop.uid: (stop.installer, stop.day, stop.seq) for stop in self.stores.list_all("p1")}
        second_id = self._enqueue()
        self.service.run_build(second_id)
        self.assertEqual(self.jobs.get(second_id).message, "0 of 20 stops moved")
        self.assertEqual(first, {stop.uid: (stop.installer, stop.day, stop.seq) for stop in self.stores.list_all("p1")})

    def test_superseded_before_start_writes_nothing(self):
        old = self._enqueue()
        self.projects._items["p1"] = self.projects.get("p1").model_copy(update={"routing_job_id": "newer"})
        self.service.run_build(old)
        self.assertEqual(self.jobs.get(old).message, SUPERSEDED)
        self.assertTrue(all(stop.installer == "" for stop in self.stores.list_all("p1")))
        self.assertEqual(self.projects.get("p1").routing_job_id, "newer")

    def test_superseded_during_compute_writes_nothing(self):
        old = self._enqueue()
        original_list_all = self.stores.list_all

        def list_all_then_take_over(project_id):
            stops = original_list_all(project_id)
            self.projects._items["p1"] = self.projects.get("p1").model_copy(update={"routing_job_id": "newer"})
            return stops

        self.stores.list_all = list_all_then_take_over
        self.service.run_build(old)
        self.assertEqual(self.jobs.get(old).status, JobStatus.FAILED)
        self.assertTrue(all(stop.installer == "" for stop in original_list_all("p1")))

    def test_superseded_at_finish_leaves_newer_job_holding_slot(self):
        old = self._enqueue()
        original = self.stores.update_routing_many

        def write_then_take_over(project_id, changes):
            written = original(project_id, changes)
            self.projects._items["p1"] = self.projects.get("p1").model_copy(update={"routing_job_id": "newer"})
            return written

        self.stores.update_routing_many = write_then_take_over
        self.service.run_build(old)
        self.assertEqual(self.jobs.get(old).message, SUPERSEDED)
        project = self.projects.get("p1")
        self.assertEqual((project.routing_status, project.routing_job_id), (RoutingStatus.BUILDING, "newer"))

    def test_failure_marks_project_and_job_failed(self):
        job_id = self._enqueue()

        def boom(*args, **kwargs):
            raise RuntimeError("optimizer exploded")

        self.service.build_assignments = boom
        self.service.run_build(job_id)
        self.assertEqual(self.jobs.get(job_id).message, "Routing failed: optimizer exploded")
        project = self.projects.get("p1")
        self.assertEqual((project.routing_status, project.routing_job_id), (RoutingStatus.FAILED, ""))

    def test_missing_job_is_a_no_op(self):
        self.service.run_build("ghost")
        self.jobs.put(Job(id="orphan", type="routing_build"))
        self.service.run_build("orphan")  # no project id: nothing to do

    def test_routes_bundle(self):
        self.service.run_build(self._enqueue())
        bundle = self.service.routes("p1")
        header = (bundle.installers, bundle.stops_per_day, bundle.routing_status)
        self.assertEqual(header, (["A", "B"], 5, RoutingStatus.READY))
        self.assertEqual(sum(stats.total for stats in bundle.stats.values()), 20)
        for installer, days in bundle.routes.items():
            self.assertEqual(bundle.stats[installer].days, len(days))
            for day in days:
                self.assertEqual([stop.seq for stop in day], list(range(len(day))))
                self.assertEqual(len({stop.day for stop in day}), 1)
            self.assertGreaterEqual(bundle.stats[installer].miles, 0)

    def test_rebalance_replans_exactly_the_pending_set(self):
        statuses = [ScreenStatus.UPCOMING, ScreenStatus.INVITATION_EMAIL_SENT, ScreenStatus.SHIPPED,
                    ScreenStatus.DELIVERED, ScreenStatus.NEEDS_MORE_WORK, ScreenStatus.OFFLINE,
                    ScreenStatus.COMPLETED, ScreenStatus.ARCHIVED,
                    ScreenStatus.CANCELLED]
        self.service.run_build(self._enqueue())  # everyone routed first
        for index, status in enumerate(statuses):
            self.stores.update_fields("p1", f"u{index:02d}", status_write(status))
        stops = self.stores.list_all("p1")
        routed, _ = RoutingService.rebalance_assignments(self.projects.get("p1"), stops)
        replanned = {stop.uid for stop in routed}
        self.assertLessEqual({f"u{i:02d}" for i in range(5)}, replanned)  # the five pending statuses move
        self.assertFalse({f"u{i:02d}" for i in range(5, 9)} & replanned)  # Offline (§7 #2) and the rest stay
        bundle = self.service.routes("p1")
        self.assertEqual(sum(stats.pending for stats in bundle.stats.values()), 20 - 4)

