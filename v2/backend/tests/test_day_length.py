"""Maximum driving day (route plans): splitting days by drive time, the Google Routes client and its fallback."""
import json
import unittest

import httpx

from dolphin_tracker.domain.route_plans import (
    NextDay,
    PlanInstaller,
    Reassign,
    RoutePlanCreate,
    RoutePlanUpdate,
    chain_legs,
    estimate_leg_minutes,
    split_long_days,
)
from dolphin_tracker.services.drive_times import MAX_POINTS, GoogleDriveTimes, windows
from dolphin_tracker.services.route_plans import RoutePlanService
from tests.test_route_plans import EAST, WEST, ServiceTestCase, refs, row


def fixed_legs(minutes: float):
    """Every leg takes `minutes`, whatever the points."""
    return lambda points: [minutes] * (len(points) - 1)


class SplitLongDaysTests(unittest.TestCase):
    def setUp(self):
        self.start = {"lat": 33.0, "lng": -84.0}
        self.day = [row(f"s{i}", 33.0, -84.0 + i * 0.1) for i in range(5)]

    def test_a_day_over_the_limit_becomes_two_and_the_next_day_starts_from_the_last_stop(self):
        # 5 stops at 84 min each = 7 h; with a 6 h limit the 5th stop moves to a new day.
        routes, minutes = split_long_days({"Ann": [self.day]}, {"Ann": self.start}, fixed_legs(84), 6 * 60)
        self.assertEqual([[r["id"] for r in day] for day in routes["Ann"]], [["s0", "s1", "s2", "s3"], ["s4"]])
        self.assertEqual(set(minutes.values()), {84})  # s4's leg runs from s3 (the hotel), not from home

    def test_no_limit_keeps_the_days_and_still_reports_minutes(self):
        routes, minutes = split_long_days({"Ann": [self.day]}, {"Ann": self.start}, fixed_legs(84), 0)
        self.assertEqual(len(routes["Ann"]), 1)
        self.assertEqual(minutes["s0"], 84)

    def test_a_stop_longer_than_the_limit_still_gets_a_day_and_days_are_never_merged(self):
        days = [self.day[:2], self.day[2:3]]
        routes, _ = split_long_days({"Ann": days}, {"Ann": self.start}, fixed_legs(500), 6 * 60)
        self.assertEqual([[r["id"] for r in day] for day in routes["Ann"]], [["s0"], ["s1"], ["s2"]])
        short, _ = split_long_days({"Ann": days}, {"Ann": self.start}, fixed_legs(10), 6 * 60)
        self.assertEqual(len(short["Ann"]), 2)  # under the limit: the two days stay two

    def test_rows_without_coordinates_have_no_leg(self):
        rows = [row("a", 33.0, -84.1), {"id": "x", "lat": None, "lng": None, "state": "GA"}, row("b", 33.0, -84.2)]
        legs = chain_legs(self.start, rows, fixed_legs(30))
        self.assertEqual(legs, {"a": 30, "x": None, "b": 30})

    def test_estimate(self):
        (minutes,) = estimate_leg_minutes([(33.0, -84.0), (33.0, -85.0)])  # ~58 miles × 1.3 at 40 mph
        self.assertAlmostEqual(minutes, 58 * 1.3 / 40 * 60, delta=5)


class GoogleDriveTimesTests(unittest.TestCase):
    def test_windows_overlap_by_one_point_and_cover_every_leg(self):
        points = [(33.0, -84.0 + i * 0.01) for i in range(60)]
        parts = windows(points)
        self.assertTrue(all(len(part) <= MAX_POINTS for part in parts))
        self.assertEqual(sum(len(part) - 1 for part in parts), 59)
        self.assertEqual(parts[1][0], parts[0][-1])

    def test_reads_leg_durations_and_sends_the_key_and_field_mask(self):
        seen = []

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            seen.append((request.headers["X-Goog-Api-Key"], request.headers["X-Goog-FieldMask"], body["travelMode"]))
            legs = [{"duration": "600s"} for _ in range(len(body["intermediates"]) + 1)]
            return httpx.Response(200, json={"routes": [{"legs": legs}]})

        client = GoogleDriveTimes("k", client=httpx.Client(transport=httpx.MockTransport(handler)))
        points = [(33.0, -84.0 + i * 0.01) for i in range(30)]
        self.assertEqual(client(points), [10.0] * 29)
        self.assertEqual(len(seen), 2)  # 30 points need two windows
        self.assertEqual(seen[0], ("k", "routes.legs.duration", "DRIVE"))

    def test_falls_back_to_the_estimate_when_google_fails(self):
        transport = httpx.MockTransport(lambda request: httpx.Response(403, json={"error": {"status": "DENIED"}}))
        client = GoogleDriveTimes("k", client=httpx.Client(transport=transport))
        points = [(33.0, -84.0), (33.0, -85.0)]
        self.assertEqual(client(points), estimate_leg_minutes(points))
        self.assertEqual(GoogleDriveTimes("")(points), estimate_leg_minutes(points))  # no key: no request


class PlanDayLengthTests(ServiceTestCase):
    def setUp(self):
        super().setUp()
        self.service = RoutePlanService(self.plans, self.stores, self.projects, self.lists, fixed_legs(100))

    def days(self, bundle, installer="West"):
        return sorted({s.day for s in bundle.stops if s.installer == installer})

    def test_max_day_hours_splits_days_that_fit_the_stop_cap(self):
        loose = self.create(per_day=4).bundle  # 4 stores per installer
        self.assertEqual((self.days(loose), self.days(loose, "East")), ([1], [1]))  # 4 × 100 min, no limit: one day
        self.service.close(loose.plan.id)
        tight = self.create(per_day=4, max_day_hours=3.5).bundle  # 210 min: two stops a day
        self.assertEqual(tight.plan.max_day_hours, 3.5)
        self.assertEqual((self.days(tight), self.days(tight, "East")), ([1, 2], [1, 2]))
        self.assertTrue(all(s.drive_minutes == 100 for s in tight.stops))

    def test_update_changes_the_default_and_next_day_overrides_one_day(self):
        plan = self.create(per_day=4).bundle.plan
        updated = self.service.update(plan.id, RoutePlanUpdate(max_day_hours=2, version=plan.version))
        self.assertEqual(updated.plan.max_day_hours, 2)
        self.assertEqual(self.days(updated), [1])  # the default replan keeps today's routes
        today = self.service.update(plan.id, RoutePlanUpdate(replan="today", version=updated.plan.version))
        self.assertEqual(self.days(today), [1, 2, 3, 4])  # 2 h a day: one 100-minute stop a day
        nxt = self.service.next_day(plan.id, NextDay(date="2026-11-07", max_day_hours=0))
        self.assertEqual((nxt.plan.days[-1].max_day_hours, nxt.plan.max_day_hours), (0, 2))  # day 2 only
        self.assertEqual({s.day for s in nxt.stops}, {2})  # no limit: each installer's 4 open stops fit day 2
        self.assertEqual(nxt.plan.limits(nxt.plan.days[-1]), (4, 0))
        third = self.service.next_day(plan.id, NextDay(date="2026-11-08"))
        self.assertEqual(third.plan.limits(third.plan.days[-1]), (4, 2))  # left out: back to the defaults
        self.assertEqual(len({s.day for s in third.stops if s.installer == "West" and s.day >= 3}), 4)

    def test_reassign_refreshes_drive_minutes(self):
        service = RoutePlanService(self.plans, self.stores, self.projects, self.lists, fixed_legs(45))
        body = RoutePlanCreate(name="GA", start_date="2026-11-06", stops_per_day=4,
                               installers=[PlanInstaller(name="West", start=WEST),
                                           PlanInstaller(name="East", start=EAST)],
                               stores=refs("w0", "w1", "e0"))
        bundle = service.create(body).bundle
        moved = service.reassign(bundle.plan.id, "p1", "w1", Reassign(installer="East"))
        east = [s for s in moved.stops if s.installer == "East"]
        self.assertEqual(len(east), 2)
        self.assertTrue(all(s.drive_minutes == 45 for s in east))
