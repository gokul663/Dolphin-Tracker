import unittest

from backend.route_optimizer import build_project_routes, clean_territory_outliers, distance, make_day_batches, orient_day_directions, rebalance_incomplete_routes, reassign_stop_preserving_days, split_territory_for_new_installer


class RouteOptimizerTests(unittest.TestCase):
    def test_uses_dynamic_installer_names_and_balances_stops(self):
        stops = [
            {"id": str(i), "lat": 32.0 + i * 0.1, "lng": -97.0 + i * 0.03}
            for i in range(12)
        ]
        routes = build_project_routes(stops, ["North Team", "South Team"], per_day=4)

        self.assertEqual(set(routes), {"North Team", "South Team"})
        counts = [sum(map(len, routes[name])) for name in routes]
        self.assertEqual(counts, [6, 6])
        self.assertTrue(all(len(day) <= 4 for days in routes.values() for day in days))
        self.assertTrue(all(stop["installer"] in routes for days in routes.values() for day in days for stop in day))

    def test_targets_eight_stops_and_adds_days_as_needed(self):
        stops = [
            {"id": str(i), "lat": 33.0 + i * 0.01, "lng": -96.0 + i * 0.01}
            for i in range(33)
        ]
        routes = build_project_routes(stops, ["A", "B"], per_day=8)

        self.assertEqual(sum(len(day) for days in routes.values() for day in days), 33)
        self.assertTrue(all(len(day) <= 8 for days in routes.values() for day in days))
        self.assertEqual(sorted(len(days) for days in routes.values()), [2, 3])

    def test_natural_territories_do_not_force_equal_cross_region_counts(self):
        north = [
            {"id": f"n{i}", "lat": 33.0 + i * 0.003, "lng": -97.0 + i * 0.002}
            for i in range(15)
        ]
        south = [
            {"id": f"s{i}", "lat": 29.7 + i * 0.003, "lng": -95.4 + i * 0.002}
            for i in range(27)
        ]

        routes = build_project_routes(north + south, ["A", "B"], per_day=8)
        territories = {
            installer: {stop["id"][0] for day in days for stop in day}
            for installer, days in routes.items()
        }
        counts = sorted(sum(len(day) for day in days) for days in routes.values())

        self.assertEqual(counts, [15, 27])
        self.assertEqual(set(map(frozenset, territories.values())), {frozenset({"n"}), frozenset({"s"})})
        self.assertTrue(all(len(day) <= 8 for days in routes.values() for day in days))

    def test_next_day_starts_near_previous_day_end(self):
        stops = [
            {"id": str(i), "lat": 32.0, "lng": -97.0 + i * 0.01}
            for i in range(16)
        ]

        days = make_day_batches(stops, per_day=8)

        self.assertEqual([len(day) for day in days], [8, 8])
        self.assertLess(distance(days[0][-1], days[1][0]), 2.0)

    def test_existing_days_are_reversed_for_a_shorter_overnight_gap(self):
        first = [
            {"id": "near-a", "lat": 32.0, "lng": -97.0},
            {"id": "far-a", "lat": 34.0, "lng": -99.0},
        ]
        second = [
            {"id": "far-b", "lat": 30.0, "lng": -95.0},
            {"id": "near-b", "lat": 32.01, "lng": -97.01},
        ]

        oriented = orient_day_directions([first, second])

        self.assertEqual(oriented[0][-1]["id"], "near-a")
        self.assertEqual(oriented[1][0]["id"], "near-b")
        self.assertLess(distance(oriented[0][-1], oriented[1][0]), 2.0)

    def test_reassignment_preserves_unrelated_day_membership(self):
        routes = {
            "North": [
                [{"id": "n1", "lat": 33.0, "lng": -97.0, "installer": "North", "day": 1},
                 {"id": "move", "lat": 33.01, "lng": -97.01, "installer": "North", "day": 1}],
                [{"id": "n2", "lat": 34.0, "lng": -98.0, "installer": "North", "day": 2}],
            ],
            "South": [
                [{"id": "s1", "lat": 32.0, "lng": -96.0, "installer": "South", "day": 1}],
                [{"id": "s2", "lat": 33.02, "lng": -97.02, "installer": "South", "day": 2}],
            ],
        }

        updated, moved, old_installer = reassign_stop_preserving_days(
            routes, "move", "South", per_day=3
        )

        self.assertEqual(old_installer, "North")
        self.assertEqual(moved["installer"], "South")
        self.assertEqual([[stop["id"] for stop in day] for day in updated["North"]], [["n1"], ["n2"]])
        self.assertEqual(
            [set(stop["id"] for stop in day) for day in updated["South"]],
            [{"s1"}, {"s2", "move"}],
        )

    def test_new_installer_rebalances_only_incomplete_stops(self):
        routes = {
            "A": [[
                {"id": "fixed", "lat": 33.0, "lng": -97.0, "installer": "A", "day": 1},
                {"id": "p1", "lat": 33.1, "lng": -97.1, "installer": "A", "day": 1},
                {"id": "p2", "lat": 33.2, "lng": -97.2, "installer": "A", "day": 1},
            ]],
            "B": [[
                {"id": "p3", "lat": 34.0, "lng": -98.0, "installer": "B", "day": 1},
                {"id": "p4", "lat": 34.1, "lng": -98.1, "installer": "B", "day": 1},
            ]],
        }

        updated = rebalance_incomplete_routes(
            routes, {"p1", "p2", "p3", "p4"}, ["A", "B", "C"], per_day=3
        )

        fixed = next(
            stop for day in updated["A"] for stop in day
            if stop["id"] == "fixed"
        )
        self.assertEqual(fixed["installer"], "A")
        self.assertTrue(all(updated[name] for name in ["A", "B", "C"]))
        moved_ids = {
            stop["id"] for days in updated.values() for day in days for stop in day
            if stop["id"].startswith("p")
        }
        self.assertEqual(moved_ids, {"p1", "p2", "p3", "p4"})

    def test_rebalance_keeps_distant_cities_on_separate_days(self):
        houston = [
            {"id": f"h{i}", "lat": 29.70 + i * 0.005, "lng": -95.40 + i * 0.005,
             "installer": "A", "day": 1}
            for i in range(8)
        ]
        dallas = [
            {"id": f"d{i}", "lat": 32.75 + i * 0.005, "lng": -96.80 + i * 0.005,
             "installer": "A", "day": 2}
            for i in range(8)
        ]
        routes = {"A": [houston, dallas]}

        updated = rebalance_incomplete_routes(
            routes, {stop["id"] for stop in houston + dallas}, ["A"], per_day=8
        )

        self.assertEqual(len(updated["A"]), 2)
        city_groups = [
            {"Houston" if stop["id"].startswith("h") else "Dallas" for stop in day}
            for day in updated["A"]
        ]
        self.assertEqual(city_groups, [{"Houston"}, {"Dallas"}])

    def test_new_installer_splits_busiest_existing_territory_without_dallas_outlier(self):
        dallas = [
            {"id": f"d{i}", "lat": 32.75 + i * 0.004, "lng": -96.80 + i * 0.004,
             "installer": "Dallas Installer", "day": 1}
            for i in range(6)
        ]
        houston = [
            {"id": f"h{i}", "lat": 29.70 + i * 0.004, "lng": -95.40 + i * 0.004,
             "installer": "Houston Installer", "day": 1 + i // 6}
            for i in range(12)
        ]
        routes = {"Dallas Installer": [dallas], "Houston Installer": [houston[:6], houston[6:]]}
        incomplete_ids = {stop["id"] for stop in dallas + houston}

        assignments = split_territory_for_new_installer(
            routes, incomplete_ids, ["Dallas Installer", "Houston Installer"], "Installer 3"
        )

        self.assertEqual({stop["id"] for stop in assignments["Dallas Installer"]}, {stop["id"] for stop in dallas})
        self.assertTrue(assignments["Installer 3"])
        self.assertTrue(all(stop["id"].startswith("h") for stop in assignments["Installer 3"]))

    def test_reoptimization_moves_lone_dallas_outlier_to_dallas_installer(self):
        dallas = [
            {"id": f"d{i}", "lat": 32.75 + i * 0.004, "lng": -96.80 + i * 0.004,
             "installer": "Dallas Installer", "day": 1}
            for i in range(5)
        ]
        houston = [
            {"id": f"h{i}", "lat": 29.70 + i * 0.004, "lng": -95.40 + i * 0.004,
             "installer": "Installer 3", "day": 1 + i // 5}
            for i in range(10)
        ]
        outlier = {"id": "d-outlier", "lat": 32.78, "lng": -96.82, "installer": "Installer 3", "day": 1}
        routes = {
            "Dallas Installer": [dallas],
            "Installer 3": [houston[:5] + [outlier], houston[5:]],
        }
        ids = {stop["id"] for stop in dallas + houston + [outlier]}

        assignments = clean_territory_outliers(
            routes, ids, ["Dallas Installer", "Installer 3"]
        )

        self.assertIn("d-outlier", {stop["id"] for stop in assignments["Dallas Installer"]})
        self.assertTrue(all(stop["id"].startswith("h") for stop in assignments["Installer 3"]))

    def test_outlier_repair_preserves_existing_days_and_uses_available_capacity(self):
        nearby = [
            {"id": f"a{i}", "lat": 32.0 + i * 0.01, "lng": -97.0,
             "installer": "A", "day": 1 + i // 3}
            for i in range(6)
        ]
        distant = [
            {"id": f"b{i}", "lat": 29.0 + i * 0.01, "lng": -95.0,
             "installer": "B", "day": 1 + i // 3}
            for i in range(6)
        ]
        outlier = {"id": "outlier", "lat": 32.03, "lng": -97.01,
                   "installer": "B", "day": 2}
        routes = {"A": [nearby[:3], nearby[3:]], "B": [distant[:3], distant[3:] + [outlier]]}
        incomplete_ids = {stop["id"] for stop in nearby + distant + [outlier]}

        assignments = clean_territory_outliers(routes, incomplete_ids, ["A", "B"])
        updated = rebalance_incomplete_routes(
            routes, incomplete_ids, ["A", "B"], per_day=4,
            assignments_override=assignments,
        )

        self.assertEqual(len(updated["A"]), 2)
        self.assertEqual(len(updated["B"]), 2)
        self.assertEqual(
            [{stop["id"] for stop in day if stop["id"].startswith("a")} for day in updated["A"]],
            [{"a0", "a1", "a2"}, {"a3", "a4", "a5"}],
        )
        self.assertIn("outlier", {stop["id"] for day in updated["A"] for stop in day})

    def test_rebalance_compacts_only_redundant_days(self):
        stops = [
            {"id": str(i), "lat": 32.0 + i * 0.01, "lng": -97.0,
             "installer": "A", "day": 1 + i // 3}
            for i in range(8)
        ]
        routes = {"A": [stops[:3], stops[3:6], stops[6:]]}

        updated = rebalance_incomplete_routes(
            routes, {stop["id"] for stop in stops}, ["A"], per_day=4,
            assignments_override={"A": stops},
        )

        self.assertEqual(len(updated["A"]), 2)
        self.assertTrue(all(len(day) == 4 for day in updated["A"]))

    def test_completed_stops_do_not_consume_pending_day_capacity(self):
        completed = [
            {"id": f"c{i}", "lat": 32.0 + i * 0.001, "lng": -97.0,
             "installer": "A", "day": 1 + i // 5}
            for i in range(14)
        ]
        pending = [
            {"id": f"p{i}", "lat": 32.1 + i * 0.001, "lng": -97.0,
             "installer": "A", "day": 1 + i // 3}
            for i in range(7)
        ]
        routes = {"A": [completed[:5] + pending[:3], completed[5:10] + pending[3:6], completed[10:] + pending[6:]]}

        updated = rebalance_incomplete_routes(
            routes, {stop["id"] for stop in pending}, ["A"], per_day=8,
            assignments_override={"A": pending},
        )
        pending_counts = [
            sum(stop["id"].startswith("p") for stop in day)
            for day in updated["A"]
        ]

        self.assertEqual(sorted(pending_counts), [0, 0, 7])
        self.assertEqual(sum(len(day) for day in updated["A"]), 21)


if __name__ == "__main__":
    unittest.main()
