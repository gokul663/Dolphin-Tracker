"""Day editing in route plans: locking days, where a store can go (with the extra driving), adding and moving."""
import unittest

from dolphin_tracker.domain.errors import ConflictError, ValidationFailed
from dolphin_tracker.domain.route_plans import (
    DayInsert,
    DayLockSet,
    InsertQuery,
    MoveToNextDay,
    NextDay,
    RoutePlanUpdate,
    StoreRef,
    insertion_options,
    skip_locked,
)
from dolphin_tracker.services.route_plans import RoutePlanService
from tests.test_route_plans import ServiceTestCase


def by_longitude(points):
    """A minute per 0.01° of longitude: easy to reason about."""
    return [abs(b[1] - a[1]) * 100 for a, b in zip(points, points[1:], strict=False)]


class InsertionOptionsTests(unittest.TestCase):
    def test_every_gap_with_its_extra_driving_and_the_cheapest_marked(self):
        day = [{"name": "A", "lat": 0, "lng": 0.01, "leg": 1}, {"name": "B", "lat": 0, "lng": 0.03, "leg": 2},
               {"name": "C", "lat": 0, "lng": 0.04, "leg": 1}]
        options = insertion_options({"lat": 0, "lng": 0}, day, {"lat": 0, "lng": 0.02}, by_longitude)
        self.assertEqual([(o.position, o.after, o.before) for o in options],
                         [(0, "", "A"), (1, "A", "B"), (2, "B", "C"), (3, "C", "")])
        self.assertEqual([o.extra_minutes for o in options], [2, 0, 2, 2])
        self.assertEqual([o.position for o in options if o.best], [1])  # on the way from A to B

    def test_rows_without_a_location_keep_their_place_in_the_positions(self):
        day = [{"name": "A", "lat": 0, "lng": 0.01, "leg": 1}, {"name": "X", "lat": None, "lng": None, "leg": None},
               {"name": "B", "lat": 0, "lng": 0.03, "leg": 2}]
        options = insertion_options({"lat": 0, "lng": 0}, day, {"lat": 0, "lng": 0.02}, by_longitude)
        self.assertEqual([o.position for o in options], [0, 2, 3])  # before A, before B (after X), at the end

    def test_a_store_without_a_location_cannot_be_placed(self):
        with self.assertRaises(ValueError):
            insertion_options({"lat": 0, "lng": 0}, [], {"lat": None, "lng": None}, by_longitude)

    def test_skip_locked_moves_laid_out_days_past_locked_ones(self):
        layout = {"a": ("Ann", 2, 0, 5), "b": ("Ann", 3, 0, 5), "c": ("Bo", 2, 0, 5)}
        moved = skip_locked(layout, {("Ann", 3)})
        self.assertEqual({k: v[1] for k, v in moved.items()}, {"a": 2, "b": 4, "c": 2})


class DayEditingTests(ServiceTestCase):
    def setUp(self):
        super().setUp()
        self.service = RoutePlanService(self.plans, self.stores, self.projects, self.lists, by_longitude)

    def day(self, bundle, installer, number):
        return [s.stop_uid for s in sorted(bundle.stops, key=lambda s: s.seq)
                if s.installer == installer and s.day == number]

    def test_a_locked_day_survives_recalculations(self):
        bundle = self.create().bundle  # 2 a day: West has days 1 and 2
        plan_id = bundle.plan.id
        west_day2 = self.day(bundle, "West", 2)
        locked = self.service.set_lock(plan_id, DayLockSet(installer="west", day=2, locked=True))
        self.assertEqual([(lock.installer, lock.day) for lock in locked.plan.locked_days], [("West", 2)])
        after = self.service.next_day(plan_id, NextDay(date="2026-11-09", stops_per_day=1))
        self.assertEqual(self.day(after, "West", 2), west_day2)  # same stores, same order
        self.assertEqual(sorted(s.day for s in after.stops if s.installer == "West" and s.stop_uid not in west_day2),
                         [3, 4])  # day 1's two unvisited stores, one a day, around the locked day
        replanned = self.service.update(plan_id, RoutePlanUpdate(replan="today", version=after.plan.version))
        self.assertEqual(self.day(replanned, "West", 2), west_day2)
        unlocked = self.service.set_lock(plan_id, DayLockSet(installer="West", day=2, locked=False))
        self.assertEqual(unlocked.plan.locked_days, [])

    def test_insert_a_free_store_where_chosen(self):
        bundle = self.create().bundle
        plan_id = bundle.plan.id
        query = InsertQuery(installer="West", day=1, store=StoreRef(project_id="p2", stop_uid="m0"))
        options = self.service.insert_options(plan_id, query)
        self.assertEqual(options.store_name, "Store m0")
        self.assertEqual(len(options.options), 3)  # before, between and after West's two day-1 stores
        self.assertEqual(sum(o.best for o in options.options), 1)
        after = self.service.insert(plan_id, DayInsert(**query.model_dump(), position=1))
        self.assertEqual(self.day(after, "West", 1)[1], "m0")
        self.assertEqual(after.plan.store_count, 9)
        self.assertEqual(self.stores.get("p2", "m0").route_plan_id, plan_id)
        added = next(s for s in after.stops if s.stop_uid == "m0")
        self.assertIsNotNone(added.drive_minutes)
        self.assertEqual(after.project_names, {"p1": "Atlanta", "p2": "Macon"})

    def test_move_a_store_from_another_day_keeps_both_days_in_order(self):
        bundle = self.create().bundle
        plan_id = bundle.plan.id
        east = self.day(bundle, "East", 1)
        after = self.service.insert(plan_id, DayInsert(installer="West", day=1, position=0,
                                                       store=StoreRef(project_id="p1", stop_uid=east[0])))
        self.assertEqual(self.day(after, "West", 1)[0], east[0])
        self.assertEqual(self.day(after, "East", 1), east[1:])
        seqs = [s.seq for s in after.stops if (s.installer, s.day) == ("East", 1)]
        self.assertEqual(seqs, list(range(len(seqs))))
        self.assertEqual(after.plan.store_count, 8)

    def test_move_to_next_day_goes_where_it_adds_least(self):
        bundle = self.create().bundle
        plan_id = bundle.plan.id
        first = self.day(bundle, "West", 1)[0]
        after = self.service.move_to_next_day(plan_id, "p1", first, MoveToNextDay())
        self.assertNotIn(first, self.day(after, "West", 1))
        self.assertIn(first, self.day(after, "West", 2))

    def test_an_emptied_locked_day_unlocks_and_rules(self):
        bundle = self.create().bundle
        plan_id = bundle.plan.id
        self.service.set_lock(plan_id, DayLockSet(installer="West", day=2, locked=True))
        for uid in self.day(bundle, "West", 2):
            after = self.service.remove_stop(plan_id, "p1", uid)
        self.assertEqual(after.plan.locked_days, [])
        self.service.record_visit(plan_id, "p1", "e0", "e0-s0")
        with self.assertRaises(ConflictError):
            self.service.move_to_next_day(plan_id, "p1", "e0", MoveToNextDay())  # visited
        self.service.next_day(plan_id, NextDay(date="2026-11-09"))
        with self.assertRaises(ValidationFailed):
            self.service.insert(plan_id, DayInsert(installer="West", day=1, position=0,
                                                   store=StoreRef(project_id="p2", stop_uid="m0")))  # day 1 is over
