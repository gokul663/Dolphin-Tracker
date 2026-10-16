from dolphin_tracker.domain.models import JobStatus, Project, RoutingStatus, StopStatus
from dolphin_tracker.services.routing import RoutingService
from tests.test_projects_api import NoopInvoker, ProjectApiTestCase, stop_input


class InstallerOpsTests(ProjectApiTestCase):
    """Routed 24-stop project (Ann, Bo; 4 per day), then each operation through the API and the inline worker."""

    def setUp(self):
        super().setUp()
        stops = [stop_input(i, state="GA" if i < 20 else "AL") for i in range(24)]
        created = self.create_project(stops=stops)
        self.pid = created["project"]["id"]
        self.assertEqual(self.projects.get(self.pid).routing_status, RoutingStatus.READY)

    def layout(self) -> dict[str, tuple[str, int, int]]:
        return {stop.uid: (stop.installer, stop.day, stop.seq) for stop in self.stores.list_all(self.pid)}

    def post(self, path: str, body: dict | None = None):
        return self.client.post(f"/api/projects/{self.pid}{path}", json=body)

    def finish(self, response) -> dict:
        self.assertEqual(response.status_code, 202, response.text)
        self.invoker.wait()
        job = self.jobs.get(response.json()["job_id"])
        self.assertEqual(job.status, JobStatus.SUCCEEDED, job.message)
        self.assertEqual(self.projects.get(self.pid).routing_status, RoutingStatus.READY)
        return job.payload

    def check_caps(self, cap: int = 4, *, pending_only: bool = False):
        """Per-day cap. For rebalance (v1 semantics) only Incomplete stops consume capacity."""
        counts: dict[tuple[str, int], int] = {}
        for stop in self.stores.list_all(self.pid):
            if pending_only and stop.status != StopStatus.INCOMPLETE:
                continue
            counts[(stop.installer, stop.day)] = counts.get((stop.installer, stop.day), 0) + 1
        self.assertTrue(all(count <= cap for count in counts.values()), counts)

    def assert_fixed_stops_kept(self, done: dict[str, tuple[str, int, int]]):
        """Non-pending stops keep their installer and stay together with the stops they shared a day with.
        The day *number* may shift when an earlier day empties out (v1 drops and renumbers empty days)."""
        layout = self.layout()
        for uid, (installer, _, _) in done.items():
            self.assertEqual(layout[uid][0], installer)
        for a in done:
            for b in done:
                if done[a][:2] == done[b][:2]:
                    self.assertEqual(layout[a][:2], layout[b][:2])

    def complete(self, count: int) -> dict[str, tuple[str, int, int]]:
        done = {}
        for stop in sorted(self.stores.list_all(self.pid), key=lambda s: s.uid)[:count]:
            self.stores.update_fields(self.pid, stop.uid, {"status": StopStatus.COMPLETE.value})
            done[stop.uid] = (stop.installer, stop.day, stop.seq)
        return done

    # ---- jobs ------------------------------------------------------------------------------------------------

    def test_add_installer_splits_the_busiest_territory(self):
        done = self.complete(5)
        payload = self.finish(self.post("/installers", {"name": " Cy "}))
        self.assertEqual((payload["mode"], payload["new_installer"]), ("add_installer", "Cy"))
        self.assertEqual(self.projects.get(self.pid).installers, ["Ann", "Bo", "Cy"])
        layout = self.layout()
        self.assertTrue(any(installer == "Cy" for installer, _, _ in layout.values()))
        self.assert_fixed_stops_kept(done)
        self.check_caps(pending_only=True)

    def test_add_installer_validation(self):
        self.assertEqual(self.post("/installers", {"name": "Ann"}).status_code, 409)
        self.assertEqual(self.post("/installers", {"name": "   "}).status_code, 422)
        self.assertEqual(self.client.post("/api/projects/nope/installers", json={"name": "X"}).status_code, 404)

    def test_rebalance_moves_only_incomplete_stops(self):
        done = self.complete(8)
        self.finish(self.post("/routing/rebalance"))
        self.assert_fixed_stops_kept(done)
        self.check_caps(pending_only=True)

    def test_recluster_rebuilds_and_keeps_progress(self):
        uid = next(iter(self.complete(1)))
        self.stores.update_fields(self.pid, uid, {"comment": "keep"})
        self.finish(self.post("/routing/recluster"))
        stop = self.stores.get(self.pid, uid)
        self.assertEqual((stop.status, stop.comment), (StopStatus.COMPLETE, "keep"))
        self.check_caps()

    def test_jobs_conflict_while_one_is_running(self):
        self.app.dependency_overrides[type(self).invoker_dep()] = lambda: NoopInvoker()  # job never finishes
        self.assertEqual(self.post("/routing/rebalance").status_code, 202)
        for path, body in (("/routing/rebalance", None), ("/routing/recluster", None), ("/installers", {"name": "Z"}),
                           ("/installers/rename", {"old_name": "Ann", "new_name": "Anna"})):
            self.assertEqual(self.post(path, body).status_code, 409, path)
        stop_uid = next(iter(self.layout()))
        self.assertEqual(self.post(f"/stops/{stop_uid}/reassign", {"installer": "Bo"}).status_code, 409)
        self.assertEqual(self.projects.get(self.pid).installers, ["Ann", "Bo"])  # failed add left no trace

    @staticmethod
    def invoker_dep():
        from dolphin_tracker.api.deps import get_worker_invoker

        return get_worker_invoker

    def test_recluster_needs_installers(self):
        self.projects._items[self.pid] = self.projects.get(self.pid).model_copy(update={"installers": []})
        self.assertEqual(self.post("/routing/recluster").status_code, 422)
        self.assertEqual(self.post("/routing/rebalance").status_code, 422)

    # ---- synchronous ------------------------------------------------------------------------------------------

    def test_rename_rewrites_installer_and_matching_installer_name_separately(self):
        ann = [s for s in self.stores.list_all(self.pid) if s.installer == "Ann"]
        self.stores.update_fields(self.pid, ann[0].uid, {"installer_name": "Ann"})
        self.stores.update_fields(self.pid, ann[1].uid, {"installer_name": "Sub"})
        writes = []
        original = self.stores.update_fields
        self.stores.update_fields = lambda p, u, c: writes.append(set(c)) or original(p, u, c)
        routing_writes = []
        original_many = self.stores.update_routing_many
        self.stores.update_routing_many = lambda p, ch: routing_writes.extend(ch) or original_many(p, ch)

        response = self.post("/installers/rename", {"old_name": "Ann", "new_name": "Anna"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["installers"], ["Anna", "Bo"])
        self.assertEqual(response.json()["routing_status"], "ready")
        stops = {s.uid: s for s in self.stores.list_all(self.pid)}
        self.assertTrue(all(stops[s.uid].installer == "Anna" for s in ann))
        self.assertEqual((stops[ann[0].uid].installer_name, stops[ann[1].uid].installer_name), ("Anna", "Sub"))
        # Every single write is one group or the other, never both (rule 5).
        self.assertIn({"installer_name"}, writes)
        self.assertTrue(all(w in ({"installer"}, {"installer_name"}) for w in writes), writes)
        self.assertEqual({tuple(change) for _, change in routing_writes}, {("installer",)})

    def test_rename_validation(self):
        self.assertEqual(self.post("/installers/rename", {"old_name": "Nope", "new_name": "X"}).status_code, 404)
        self.assertEqual(self.post("/installers/rename", {"old_name": "Ann", "new_name": "Bo"}).status_code, 409)
        self.assertEqual(self.post("/installers/rename", {"old_name": "Ann", "new_name": " "}).status_code, 422)
        same = self.post("/installers/rename", {"old_name": "Ann", "new_name": "Ann"})
        self.assertEqual(same.json()["installers"], ["Ann", "Bo"])

    def test_reassign_moves_one_stop_and_keeps_other_days(self):
        before = self.layout()
        uid, (old, old_day, _) = next((u, a) for u, a in before.items() if a[0] == "Ann")
        response = self.post(f"/stops/{uid}/reassign", {"installer": "Bo"})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual((body["old_installer"], body["installer"]), ("Ann", "Bo"))
        self.assertIn(uid, body["changed"])
        after = self.layout()
        self.assertEqual(after[uid][0], "Bo")
        for other, (installer, _day, _) in before.items():  # nobody else changes installer
            if other != uid:
                self.assertEqual(after[other][0], installer)
        self.assertEqual(set(body["changed"]), {u for u in before if before[u] != after[u]})
        self.assertEqual(self.projects.get(self.pid).routing_status, RoutingStatus.READY)  # slot released

    def test_reassign_to_same_installer_changes_nothing(self):
        uid, (installer, _, _) = next(iter(self.layout().items()))
        body = self.post(f"/stops/{uid}/reassign", {"installer": installer}).json()
        self.assertEqual(body["changed"], [])

    def test_reassign_errors_release_the_slot(self):
        self.assertEqual(self.post("/stops/ghost/reassign", {"installer": "Bo"}).status_code, 404)
        self.assertEqual(self.projects.get(self.pid).routing_job_id, "")
        uid = next(iter(self.layout()))
        self.assertEqual(self.post(f"/stops/{uid}/reassign", {"installer": "Zed"}).status_code, 422)

    def test_sync_ops_keep_a_failed_status_visible(self):
        self.projects._items[self.pid] = self.projects.get(self.pid).model_copy(
            update={"routing_status": RoutingStatus.FAILED}
        )
        self.post("/installers/rename", {"old_name": "Ann", "new_name": "Anna"})
        self.assertEqual(self.projects.get(self.pid).routing_status, RoutingStatus.FAILED)


class RebalanceAssignmentTests(ProjectApiTestCase):
    def test_unassigned_stops_are_left_alone_by_rebalance(self):
        project = Project(id="x", name="x", project_type="offline", installers=["A"], stops_per_day=3)
        from dolphin_tracker.domain.models import Stop

        stops = [Stop(uid=f"u{i}", store_name="s", addr="a", lat=33 + i / 100, lng=-84, installer="A", day=1, seq=i)
                 for i in range(3)]
        stops.append(Stop(uid="lonely", store_name="s", addr="a", installer=""))
        routed, assignments = RoutingService.rebalance_assignments(project, stops)
        self.assertNotIn("lonely", assignments)
        self.assertEqual({s.uid for s in routed}, {"u0", "u1", "u2", "lonely"})
