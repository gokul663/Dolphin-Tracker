"""The More filters (screen and mount number comparisons, committed > installed, tag, registration days) and the
Nearby filter (stores within a radius of a point, the distance sort and the distances on the list page)."""
import csv
import io

from dolphin_tracker.domain.device import ScreenDevice
from dolphin_tracker.domain.models import Project, ProjectType, Screen, Stop
from dolphin_tracker.domain.route_optimizer import haversine
from tests.test_stores_api import StoresApiTestCase


def registered(status: str, first: str, last: str, **values) -> Screen:
    return Screen(status=status, device=ScreenDevice(first_registered=first, last_registered=last), **values)


def seed() -> list[Stop]:
    return [
        # Done with one of two committed screens on the wall: a mismatch (Needs review), and committed > installed.
        Stop(uid="a", display_id="S1", store_name="Alpha", addr="1 A St", lat=33.7, lng=-84.4, tag="Done",
             committed_dolphin_screens=2,
             screens=[registered("Completed", "2026-01-01T05:00:00+00:00", "2026-03-31T23:59:00+00:00",
                                 has_mount=True)]),
        # Not done yet (one screen still Upcoming), so no mismatch, but still fewer installed than committed.
        Stop(uid="b", display_id="S2", store_name="Bravo", addr="2 B St", lat=33.8, lng=-84.4,
             committed_dolphin_screens=2,
             screens=[Screen(status="Upcoming", has_mount=True),
                      registered("Completed", "2025-12-31T23:59:59+00:00", "2026-04-01T00:00:00+00:00")]),
        # Everything committed is installed; no location; a tag the project no longer offers.
        Stop(uid="c", display_id="S3", store_name="Charlie", addr="3 C St", tag="Old", committed_dolphin_screens=2,
             screens=[Screen(status="Completed"), Screen(status="Completed")]),
        # Nothing committed, nothing registered, far away.
        Stop(uid="d", display_id="S4", store_name="Delta", addr="4 D St", lat=35.0, lng=-85.3,
             screens=[Screen(status="Upcoming")]),
        # Done and short of its commitment, but the mismatch was ignored for these numbers.
        Stop(uid="e", display_id="S5", store_name="Echo", addr="5 E St", lat=33.7, lng=-84.5, tag="Done",
             committed_dolphin_screens=3, mismatch_ignore={"committed": 3, "rows": 1},
             screens=[Screen(status="Completed")]),
    ]


class MoreFilterBase(StoresApiTestCase):
    def setUp(self):
        super().setUp()
        self.projects.put(Project(id="p1", name="P", pa="North", project_type=ProjectType.OFFLINE,
                                  tag_options=["To Do", "Done"]))
        self.stores.delete_all("p1")
        self.stores.put_many("p1", seed())

    def options(self, **params) -> dict:
        response = self.get("/filters", **params)
        self.assertEqual(response.status_code, 200, response.text)
        return {name: [(o["value"], o["count"]) for o in values] for name, values in response.json().items()}


class MoreFilterTests(MoreFilterBase):
    def test_number_filters_compare_higher_lower_or_equal_at_the_boundary(self):
        # Committed: a 2, b 2, c 2, d 0 (nothing committed), e 3. Installed: a 1, b 1, c 2, d 0, e 1.
        self.assertEqual(self.uids(screens_committed="gt:2"), ["e"])
        self.assertEqual(self.uids(screens_committed="eq:2"), ["a", "b", "c"])
        self.assertEqual(self.uids(screens_committed="lt:2"), ["d"])  # nothing committed counts as 0
        self.assertEqual(self.uids(screens_committed="eq:0"), ["d"])
        self.assertEqual(self.uids(screens_committed="lt:0"), [])
        self.assertEqual(len(self.uids(screens_committed="gt:0")), 4)
        self.assertEqual(self.uids(screens_installed="gt:1"), ["c"])
        self.assertEqual(self.uids(screens_installed="lt:1"), ["d"])
        self.assertEqual(self.uids(mounts_needed="eq:1"), ["b"])
        self.assertEqual(self.uids(mounts_needed="gt:0"), ["b"])
        self.assertEqual(self.uids(mounts_installed="gt:0"), ["a"])
        # Several number filters AND together, and with the other filters.
        self.assertEqual(self.uids(screens_committed="eq:2", screens_installed="lt:2"), ["a", "b"])
        self.assertEqual(self.uids(screens_committed="gt:1", tag="Done"), ["a", "e"])

    def test_number_filters_validate_strictly_and_are_not_listed_as_options(self):
        for bad in ("2", "gte:2", "gt:", "gt:-1", "gt:2.5", "GT:2", "gt:2:3", "gt:abc", "gt:1234567"):
            self.assertEqual(self.get(screens_committed=bad).status_code, 422, bad)
        self.assertEqual(self.get(mounts_installed=["gt:1", "lt:3"]).status_code, 200)  # one value read: the last
        options = self.options()
        for name in ("screens_committed", "screens_installed", "mounts_needed", "mounts_installed"):
            self.assertNotIn(name, options)

    def test_committed_over_installed_is_the_literal_rule_ignored_mismatch_included(self):
        self.assertEqual(self.options()["committed_over_installed"], [("Yes", 3), ("No", 2)])
        self.assertEqual(self.uids(committed_over_installed="Yes"), ["a", "b", "e"])  # b is not done; e is ignored
        self.assertEqual(self.uids(committed_over_installed="No"), ["c", "d"])
        # Narrower: the Needs review rule leaves out b (not done) and e (ignored).
        self.assertEqual(self.uids(fulfilled="Needs review"), ["a"])

    def test_tag_lists_every_project_tag_then_stale_ones_then_no_tag(self):
        self.assertEqual(self.options()["tag"], [("To Do", 0), ("Done", 2), ("Old", 1), ("", 2)])
        self.assertEqual(self.uids(tag="Done"), ["a", "e"])
        self.assertEqual(self.uids(tag=""), ["b", "d"])  # no tag
        self.assertEqual(self.uids(tag=["Old", ""]), ["b", "c", "d"])
        self.assertEqual(self.uids(sort="tag"), ["a", "e", "c", "b", "d"])  # Done, Done, Old; blanks last

    def test_facet_counts_follow_the_other_active_filters(self):
        options = self.options(tag="Done")
        self.assertEqual(options["committed_over_installed"], [("Yes", 2)])  # only a and e
        self.assertEqual(options["tag"], [("To Do", 0), ("Done", 2), ("Old", 1), ("", 2)])  # not by itself
        self.assertEqual(self.options(committed_over_installed="No")["tag"],
                         [("To Do", 0), ("Done", 0), ("Old", 1), ("", 1)])
        self.assertEqual(self.options(first_registered_from="2026-01-01")["tag"],
                         [("To Do", 0), ("Done", 1)])
        # The number comparisons narrow the other facets' counts too.
        self.assertEqual(self.options(screens_committed="eq:2")["tag"],
                         [("To Do", 0), ("Done", 1), ("Old", 1), ("", 1)])

    def test_registration_ranges_are_inclusive_days_and_either_end_is_optional(self):
        self.assertEqual(self.uids(first_registered_from="2026-01-01"), ["a"])
        self.assertEqual(self.uids(first_registered_to="2025-12-31"), ["b"])  # 23:59:59 UTC on the last day
        self.assertEqual(self.uids(first_registered_from="2025-12-31", first_registered_to="2026-01-01"), ["a", "b"])
        self.assertEqual(self.uids(last_registered_to="2026-03-31"), ["a"])
        self.assertEqual(self.uids(last_registered_from="2026-04-01", last_registered_to="2026-04-01"), ["b"])
        self.assertEqual(self.uids(first_registered_from="2027-01-01"), [])
        # Both ranges AND together, and with the facets.
        self.assertEqual(self.uids(first_registered_from="2025-01-01", last_registered_from="2026-04-01"), ["b"])
        self.assertEqual(self.uids(first_registered_from="2025-01-01", tag="Done"), ["a"])
        # A store with no registration data never matches an active range; an empty range is no filter.
        self.assertNotIn("d", self.uids(first_registered_to="2030-01-01"))
        self.assertEqual(len(self.uids(first_registered_from="", first_registered_to="")), 5)
        self.assertEqual(self.get(first_registered_from="01/02/2026").status_code, 422)

    def test_every_store_endpoint_takes_the_new_filters(self):
        params = {"committed_over_installed": "Yes", "first_registered_from": "2025-01-01"}
        self.assertEqual(sorted(pin["uid"] for pin in self.get("/pins", **params).json()), ["a", "b"])
        overview = self.get("/overview", **params).json()
        self.assertEqual(sorted(pin["uid"] for pin in overview["pins"]), ["a", "b"])
        self.assertEqual(overview["filters"]["tag"][1], {"value": "Done", "count": 1})
        self.assertEqual(self.get("/hardware", **params).json()["installed_screens"], 2)
        self.assertEqual(self.get("/screens", tag="Done", limit=50).json()["total"], 2)
        rows = list(csv.DictReader(io.StringIO(self.get("/export.csv", tag="Done").text)))
        self.assertEqual([row["Tag"] for row in rows], ["Done", "Done"])
        numbers = {"screens_committed": "eq:2", "screens_installed": "lt:2"}  # a and b
        self.assertEqual(sorted(pin["uid"] for pin in self.get("/pins", **numbers).json()), ["a", "b"])
        overview = self.get("/overview", **numbers).json()
        self.assertEqual(sorted(pin["uid"] for pin in overview["pins"]), ["a", "b"])
        self.assertEqual(self.get("/hardware", **numbers).json()["installed_screens"], 2)
        self.assertEqual(self.get("/screens", limit=50, **numbers).json()["total"], 3)
        self.assertEqual(self.get("/by-state", **numbers).status_code, 200)
        rows = list(csv.DictReader(io.StringIO(self.get("/export.csv", **numbers).text)))
        self.assertEqual(len(rows), 2)


class NearbyTests(MoreFilterBase):
    def near(self, radius: float, **params) -> list[str]:
        return self.uids(near_lat=33.7, near_lng=-84.4, radius_miles=radius, **params)

    def test_radius_keeps_stores_within_it_inclusive_and_never_ones_without_a_location(self):
        to_b = haversine(33.7, -84.4, 33.8, -84.4)  # about 6.9 miles
        to_e = haversine(33.7, -84.4, 33.7, -84.5)  # about 5.8 miles
        self.assertEqual(self.near(1), ["a"])
        self.assertEqual(self.near(to_e), ["a", "e"])  # exactly on the edge counts
        self.assertEqual(self.near(to_b - 0.001, sort="store_name"), ["a", "e"])
        self.assertEqual(self.near(to_b, sort="store_name"), ["a", "b", "e"])
        self.assertNotIn("c", self.near(3000))  # c has no location
        self.assertEqual(sorted(self.near(3000)), ["a", "b", "d", "e"])

    def test_nearby_combines_with_the_other_filters_and_every_endpoint(self):
        self.assertEqual(self.near(10, tag="Done", sort="store_name"), ["a", "e"])
        params = {"near_lat": 33.7, "near_lng": -84.4, "radius_miles": 10}
        self.assertEqual(sorted(pin["uid"] for pin in self.get("/pins", **params).json()), ["a", "b", "e"])
        self.assertEqual(self.options(**params)["tag"], [("To Do", 0), ("Done", 2), ("", 1)])
        self.assertEqual(self.get("/overview", **params).json()["by_state"], [])  # no state on the seed stores
        rows = list(csv.DictReader(io.StringIO(self.get("/export.csv", **params).text)))
        self.assertEqual(len(rows), 3)

    def test_distance_sort_nearest_first_and_distances_on_the_page(self):
        page = self.get(near_lat=33.7, near_lng=-84.4, radius_miles=200, sort="distance").json()
        self.assertEqual([stop["uid"] for stop in page["items"]], ["a", "e", "b", "d"])
        self.assertEqual(page["distances"]["a"], 0.0)
        self.assertAlmostEqual(page["distances"]["b"], 6.91, places=2)
        self.assertGreater(page["distances"]["d"], 100)
        far_first = self.uids(near_lat=33.7, near_lng=-84.4, radius_miles=200, sort="distance", dir="desc")
        self.assertEqual(far_first, ["d", "b", "e", "a"])
        self.assertIsNone(self.get().json()["distances"])  # only while the filter is on
        self.assertNotIn("distance", self.get().json()["items"][0])  # never on the store itself

    def test_distance_sort_needs_the_filter_and_the_filter_needs_all_three_parts(self):
        self.assertEqual(self.get(sort="distance").status_code, 400)
        self.assertEqual(self.get(near_lat=33.7, near_lng=-84.4).status_code, 400)
        self.assertEqual(self.get(near_lat=33.7, near_lng=-84.4, radius_miles=0).status_code, 422)
        self.assertEqual(self.get(near_lat=95, near_lng=-84.4, radius_miles=5).status_code, 422)
