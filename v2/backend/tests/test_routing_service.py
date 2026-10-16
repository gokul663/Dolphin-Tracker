import unittest

from dolphin_tracker.domain.models import Stop
from dolphin_tracker.services.routing import RoutingService


def make_stops(count: int) -> list[Stop]:
    return [
        Stop(
            uid=f"u{i}", store_name=f"Store {i}", addr=f"{i} Main St", state="GA",
            lat=33.3 + i * 0.01, lng=-84.5 + i * 0.013,
        )
        for i in range(count)
    ]


class RoutingServiceTests(unittest.TestCase):
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
        assignments = {"u0": ("A", 1, 0), "u1": ("B", 1, 0), "u2": ("B", 1, 1)}
        changes = dict(RoutingService.diff(stops, assignments))
        self.assertEqual(set(changes), {"u1", "u2"})
        self.assertEqual(changes["u2"], {"installer": "B", "day": 1, "seq": 1})

    def test_stops_without_coordinates_are_still_assigned(self):
        stops = make_stops(4)
        stops[3].lat = stops[3].lng = None
        assignments = RoutingService.build_assignments(stops, ["A"], per_day=8)
        self.assertIn("u3", assignments)
