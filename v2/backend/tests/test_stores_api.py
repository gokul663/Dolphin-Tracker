"""Store API v2 (AGENT-HANDOFF §11 S4, STORE-MODEL §2–§5) through TestClient with in-memory repositories."""
import csv
import io
import unittest

from fastapi.testclient import TestClient

from dolphin_tracker.api.app import create_app
from dolphin_tracker.api.deps import get_geocoder, get_project_repository, get_store_repository
from dolphin_tracker.domain.models import FieldDef, FieldType, Project, ProjectType, Screen, Stop
from dolphin_tracker.repositories.memory import InMemoryProjectRepository, InMemoryStoreRepository
from tests.fakes import FakeGeocoder, geocode_ok
from tests.test_dynamo import wrong_shape

SCHEMA = [FieldDef(key="tier", label="Tier"), FieldDef(key="screens_wanted", label="Screens wanted",
                                                       type=FieldType.NUMBER)]


def seed_stops() -> list[Stop]:
    def screen(status: str, venue_id: str, size: str = "", dolphin: bool = True) -> Screen:
        return Screen(status=status, venue_id=venue_id, screen_size=size, is_dolphin_screen=dolphin)

    return [
        Stop(uid="a", display_id="S1", external_id="IBC-1", store_name="Bravo Mart", addr="10 Oak St", city="Atlanta",
             state="GA", zip="30303", installer="Ann", day=1, dma="ATL", venue_type="Bar",
             screens=[screen("Completed", "V1", "24in")], committed_dolphin_screens=2,
             fields={"tier": "Gold", "screens_wanted": 2}, lat=33.7, lng=-84.4,
             updated_at="2026-10-01T00:00:00+00:00"),
        Stop(uid="b", display_id="S2", external_id="IBC-2", store_name="alpha cafe", addr="5 Elm St", city="Decatur",
             state="GA", zip="30030", installer="Bo", day=2, dma="ATL", pa="South", comment="call owner",
             screens=[screen("Upcoming", "V2"), screen("Shipped", "V3", "32in", dolphin=False)],
             fields={"tier": "Silver", "screens_wanted": 10}, lat=33.8, lng=-84.4,
             updated_at="2026-10-02T00:00:00+00:00"),
        Stop(uid="c", display_id="S10", external_id="IBC-10", store_name="Charlie Gas", addr="1 Pine Rd", city="Macon",
             state="GA", zip="31201", installer="Ann", day=2, dma="MCN", screens=[screen("Offline", "")],
             updated_at="2026-10-03T00:00:00+00:00"),
        Stop(uid="d", display_id="S3", external_id="IBC-3", store_name="Delta Deli", addr="7 Ash Ave",
             city="Chattanooga", state="TN", zip="37402", installer="", day=1, lat=35.0, lng=-85.3,
             updated_at="2026-10-04T00:00:00+00:00"),
    ]


class StoresApiTestCase(unittest.TestCase):
    def setUp(self):
        self.projects = InMemoryProjectRepository()
        self.projects.put(Project(id="p1", name="P", pa="North", project_type=ProjectType.OFFLINE,
                                  installers=["Ann", "Bo"], field_schema=SCHEMA))
        self.stores = InMemoryStoreRepository()
        self.stores.put_many("p1", seed_stops())
        self.geocoder = FakeGeocoder(
            geocodes={
                "99 New St, Atlanta, GA, 30303": geocode_ok("99 New St", lat=33.9, lng=-84.1),
                "Main, Atlanta, GA, 30303": geocode_ok("Main St", partial=True),
            },
            autocomplete={"nowhere, Atlanta, GA, 30303": ["1 Nowhere Ln, Atlanta, GA, USA"]},
        )
        self.app = create_app()
        self.app.dependency_overrides[get_project_repository] = lambda: self.projects
        self.app.dependency_overrides[get_store_repository] = lambda: self.stores
        self.app.dependency_overrides[get_geocoder] = lambda: self.geocoder
        self.client = TestClient(self.app)

    def get(self, suffix: str = "", **params):
        return self.client.get(f"/api/projects/p1/stores{suffix}", params=params)

    def uids(self, **params) -> list[str]:
        response = self.get(limit=200, **params)
        self.assertEqual(response.status_code, 200, response.text)
        return [stop["uid"] for stop in response.json()["items"]]

    def patch(self, uid: str, body: dict, suffix: str = ""):
        return self.client.patch(f"/api/projects/p1/stores/{uid}{suffix}", json=body)

    def put_screens(self, uid: str, body: dict):
        return self.client.put(f"/api/projects/p1/stores/{uid}/screens", json=body)


class ListTests(StoresApiTestCase):
    def test_default_sort_is_store_name_case_insensitive(self):
        self.assertEqual(self.uids(), ["b", "a", "c", "d"])
        self.assertEqual(self.uids(dir="desc"), ["d", "c", "a", "b"])

    def test_sort_keys(self):
        self.assertEqual(self.uids(sort="display_id"), ["a", "b", "d", "c"])  # natural: S10 after S3
        self.assertEqual(self.uids(sort="external_id"), ["a", "b", "d", "c"])  # natural too
        self.assertEqual(self.uids(sort="day"), ["a", "d", "b", "c"])  # ties keep display order
        self.assertEqual(self.uids(sort="updated_at", dir="desc"), ["d", "c", "b", "a"])
        self.assertEqual(self.uids(sort="installer"), ["a", "c", "b", "d"])  # blank installer last
        self.assertEqual(self.uids(sort="status"), ["b", "d", "c", "a"])  # least progressed first
        self.assertEqual(self.uids(sort="screens", dir="desc"), ["b", "a", "d", "c"])
        self.assertEqual(self.uids(sort="dma"), ["a", "b", "c", "d"])  # blank dma last
        self.assertEqual(self.uids(sort="fields.screens_wanted"), ["a", "b", "d", "c"])  # blanks last
        self.assertEqual(self.uids(sort="fields.screens_wanted", dir="desc"), ["b", "a", "d", "c"])

    def test_bad_sort_is_400(self):
        for params in ({"sort": "lat"}, {"sort": "fields.nope"}, {"sort": "spot_visible"}):
            self.assertEqual(self.get(**params).status_code, 400, params)
        self.assertEqual(self.get(dir="up").status_code, 422)

    def test_filters(self):
        self.assertEqual(self.uids(status="Upcoming"), ["b", "d"])
        self.assertEqual(sorted(self.uids(status=["Completed", "Offline"])), ["a", "c"])
        self.assertEqual(self.uids(installer="Ann"), ["a", "c"])
        self.assertEqual(self.uids(installer=""), ["d"])  # unassigned
        self.assertEqual(self.uids(pa="South"), ["b"])
        self.assertEqual(self.uids(pa="North"), ["a", "c", "d"])  # no PA on the store: the project's applies
        self.assertEqual(self.uids(state="TN"), ["d"])
        self.assertEqual(self.uids(city=["Decatur", "Macon"]), ["b", "c"])
        self.assertEqual(self.uids(dma="ATL"), ["b", "a"])
        self.assertEqual(self.uids(venue_type="Bar"), ["a"])
        self.assertEqual(self.uids(dd_code="V3"), ["b"])  # any screen's venue id
        self.assertEqual(self.uids(screen_size="24in"), ["a"])
        self.assertEqual(self.uids(dma="ATL", status="Upcoming"), ["b"])  # filters AND together
        self.assertEqual(self.get(status="Nope").status_code, 422)

    def test_search(self):
        self.assertEqual(self.uids(q="atlanta"), ["a"])  # city
        self.assertEqual(self.uids(q="MCN"), ["c"])  # dma
        self.assertEqual(self.uids(q="owner"), ["b"])  # comment
        self.assertEqual(self.uids(q="31201"), ["c"])  # zip
        self.assertEqual(self.uids(q="s10"), ["c"])  # display id
        self.assertEqual(self.uids(q="ibc-2"), ["b"])  # IBC#
        self.assertEqual(self.uids(q="v3"), ["b"])  # a screen's venue id
        self.assertEqual(self.uids(q="gold"), ["a"])  # extra fields

    def test_cursor_pagination(self):
        first = self.get(limit=3).json()
        self.assertEqual(len(first["items"]), 3)
        second = self.get(limit=3, cursor=first["next_cursor"]).json()
        self.assertEqual([s["uid"] for s in second["items"]], ["d"])
        self.assertIsNone(second["next_cursor"])
        self.assertEqual(self.get(cursor="%%").status_code, 400)
        for payload in ([1], "str", 5, {"offset": "x"}, {"offset": -1}):
            with self.subTest(payload=payload):
                self.assertEqual(self.get(cursor=wrong_shape(payload)).status_code, 400)
        self.assertEqual(self.get(limit=0).status_code, 422)

    def test_unknown_project_is_404(self):
        for path in ("", "/pins", "/export.csv", "/filters", "/by-state", "/field-usage", "/a"):
            self.assertEqual(self.client.get(f"/api/projects/nope/stores{path}").status_code, 404, path)

    def test_pins_are_located_stops_only_and_filtered(self):
        pins = self.get("/pins").json()
        self.assertEqual({pin["uid"] for pin in pins}, {"a", "b", "d"})
        self.assertEqual(set(pins[0]), {"uid", "lat", "lng", "status", "store_name", "installer", "day",
                                        "route_plan_id", "visit_state"})
        self.assertEqual([p["uid"] for p in self.get("/pins", status="Completed").json()], ["a"])
        self.assertEqual([p["uid"] for p in self.get("/pins", state="TN").json()], ["d"])

    def test_route_and_visit_overlays(self):
        """ROUTE-PLANNER §6: In route from the store's plan; Visited when every stick has a visit since that plan."""
        b = self.stores.get("p1", "b")
        self.stores.update_fields("p1", "b", {
            "route_plan_id": "plan1", "last_planned_at": "2026-11-01",
            "screen_visits": {b.screens[0].id: "2026-11-02"},  # one of two sticks
        })
        a = self.stores.get("p1", "a")
        self.stores.update_fields("p1", "a", {"screen_visits": {a.screens[0].id: "2026-10-01"}})
        pins = {pin["uid"]: pin for pin in self.get("/pins").json()}
        self.assertEqual((pins["b"]["route_plan_id"], pins["b"]["visit_state"]), ("plan1", "partly"))
        self.assertEqual((pins["a"]["route_plan_id"], pins["a"]["visit_state"]), ("", "visited"))
        self.assertEqual(pins["d"]["visit_state"], "none")
        in_route = self.get("/pins", route="In route").json()
        self.assertEqual([p["uid"] for p in in_route], ["b"])
        fresh = self.get("/pins", route="Not in route", visit="Not visited").json()
        self.assertEqual({p["uid"] for p in fresh}, {"d"})
        options = self.get("/filters").json()
        self.assertEqual(options["route"], [{"value": "In route", "count": 1}, {"value": "Not in route", "count": 3}])
        self.assertEqual([o["value"] for o in options["visit"]], ["Visited", "Partly visited", "Not visited"])

    def test_get_one(self):
        stop = self.get("/b").json()
        self.assertEqual((stop["store_name"], stop["status"], len(stop["screens"])), ("alpha cafe", "Upcoming", 2))
        self.assertEqual(self.get("/zzz").status_code, 404)

    def test_field_usage_counts_stores_with_a_value(self):
        self.stores.update_fields("p1", "b", {"fields.tier": ""})  # blank values don't count
        self.assertEqual(self.get("/field-usage").json(), {"tier": 1, "screens_wanted": 2})


class FilterOptionTests(StoresApiTestCase):
    def options(self, **params) -> dict:
        response = self.get("/filters", **params)
        self.assertEqual(response.status_code, 200, response.text)
        return {name: [(o["value"], o["count"]) for o in values] for name, values in response.json().items()}

    def test_distinct_values_with_counts(self):
        options = self.options()
        self.assertEqual(options["status"], [("Upcoming", 2), ("Offline", 1), ("Completed", 1)])  # precedence order
        self.assertEqual(options["installer"], [("Ann", 2), ("Bo", 1), ("", 1)])  # unassigned last
        self.assertEqual(options["pa"], [("North", 3), ("South", 1)])
        self.assertEqual(options["state"], [("GA", 3), ("TN", 1)])
        self.assertEqual(options["city"], [("Atlanta", 1), ("Chattanooga", 1), ("Decatur", 1), ("Macon", 1)])
        self.assertEqual(options["dma"], [("ATL", 2), ("MCN", 1)])
        self.assertEqual(options["venue_type"], [("Bar", 1)])
        self.assertEqual(options["dd_code"], [("V1", 1), ("V2", 1), ("V3", 1)])
        self.assertEqual(options["screen_size"], [("24in", 1), ("32in", 1)])

    def test_each_filter_is_counted_under_the_others(self):
        options = self.options(state="GA", status="Completed")
        self.assertEqual(options["city"], [("Atlanta", 1)])  # narrowed by both other filters
        self.assertEqual(options["status"], [("Upcoming", 1), ("Offline", 1), ("Completed", 1)])  # not by itself
        self.assertEqual(options["state"], [("GA", 1)])  # Completed stores only

    def test_a_filter_with_no_values_is_empty(self):
        options = self.options(installer="")  # only d: no DMA, no screens with ids or sizes
        self.assertEqual((options["dma"], options["dd_code"], options["screen_size"]), ([], [], []))
        self.assertEqual(options["installer"], [("Ann", 2), ("Bo", 1), ("", 1)])


class ByStateTests(StoresApiTestCase):
    def ranks(self, **params) -> list[tuple[str, int]]:
        response = self.get("/by-state", **params)
        self.assertEqual(response.status_code, 200, response.text)
        return [(row["state"], row["count"]) for row in response.json()]

    def test_pending_stores_per_state(self):
        self.assertEqual(self.ranks(), [("GA", 1), ("TN", 1)])  # b and d; a is Completed, c Offline (not pending)
        self.assertEqual(self.ranks(pending="false"), [("GA", 3), ("TN", 1)])
        self.assertEqual(self.ranks(pending="false", limit=1), [("GA", 3)])

    def test_other_filters_apply_but_not_state(self):
        self.assertEqual(self.ranks(state="TN"), [("GA", 1), ("TN", 1)])  # the chart keeps every bar
        self.assertEqual(self.ranks(dma="ATL"), [("GA", 1)])


class ExportTests(StoresApiTestCase):
    def test_columns_follow_the_store_model(self):
        self.stores.update_fields("p1", "a", {"comment": '=HYPERLINK("x")', "spot_visible": True})
        response = self.get("/export.csv", installer="Ann")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("text/csv"))
        self.assertIn("attachment", response.headers["content-disposition"])
        rows = list(csv.reader(io.StringIO(response.text)))
        header = rows[0]
        self.assertEqual(header[:6], ["ID", "IBC#", "Store name", "Address", "City", "State"])
        for column in ("Store owner email", "Spot visible from most of store", "Dolphin screens (committed)",
                       "Screen rows", "Status", "Tier", "Screens wanted"):
            self.assertIn(column, header)
        self.assertLess(header.index("Store owner email"), header.index("Store SSID"))  # §3 order
        self.assertEqual([row[0] for row in rows[1:]], ["S1", "S10"])
        a = dict(zip(header, rows[1], strict=True))
        self.assertEqual((a["IBC#"], a["PA"], a["Status"], a["Screens"]), ("IBC-1", "North", "Completed", "1"))
        self.assertEqual(a["Comment"], "'=HYPERLINK(\"x\")")  # formula neutralised
        self.assertEqual((a["Spot visible from most of store"], a["Power outlet within 6 ft"]), ("yes", ""))
        self.assertEqual(a["Screen rows"], "— / V1 / 24in / Dolphin screen / wall mount (none yet) / Completed")
        self.assertEqual((a["Dolphin screens (committed)"], a["Dolphin screens (actual)"]), ("2", "1"))
        self.assertEqual(a["Tier"], "Gold")

    def test_screen_rows_are_joined(self):
        rows = list(csv.reader(io.StringIO(self.get("/export.csv", installer="Bo").text)))
        b = dict(zip(rows[0], rows[1], strict=True))
        self.assertEqual(b["Screen rows"].count("; "), 1)
        self.assertEqual((b["Dolphin screens (actual)"], b["Store TVs (actual)"], b["PA"]), ("1", "1", "South"))


class DetailEditTests(StoresApiTestCase):
    def test_edit_without_address_change_skips_geocoding(self):
        body = {"store_name": " Bravo Market ", "owner_phone": "(404) 555-0100", "spot_visible": False,
                "committed_store_tvs": 3, "outlet_status": "Existing", "fields": {"tier": "Platinum"}}
        response = self.patch("a", body)
        self.assertEqual(response.status_code, 200, response.text)
        stop = response.json()
        self.assertEqual((stop["store_name"], stop["owner_phone"], stop["spot_visible"]),
                         ("Bravo Market", "(404) 555-0100", False))
        self.assertEqual((stop["committed_store_tvs"], stop["outlet_status"]), (3, "Existing"))
        self.assertEqual(stop["fields"], {"tier": "Platinum", "screens_wanted": 2})
        self.assertFalse(stop["route_stale"])
        self.assertEqual(self.geocoder.calls, [])
        cleared = self.patch("a", {"spot_visible": None, "committed_store_tvs": None}).json()
        self.assertEqual((cleared["spot_visible"], cleared["committed_store_tvs"]), (None, None))  # back to unknown
        self.assertEqual(self.patch("a", {"addr": "10 Oak St"}).json()["lat"], 33.7)  # same address: no geocode
        self.assertEqual(self.geocoder.calls, [])

    def test_address_change_geocodes_and_marks_route_stale(self):
        stop = self.patch("a", {"addr": "99 New St"}).json()
        self.assertEqual((stop["addr"], stop["lat"], stop["lng"]), ("99 New St", 33.9, -84.1))
        self.assertEqual(stop["geocoded"], "99 New St, Atlanta, GA 30303, USA")
        self.assertTrue(stop["route_stale"])
        self.assertEqual((stop["installer"], stop["day"], stop["status"]), ("Ann", 1, "Completed"))  # untouched

    def test_partial_or_failed_geocode_is_422_with_suggestions(self):
        partial = self.patch("a", {"addr": "Main"})
        self.assertEqual(partial.status_code, 422)
        self.assertEqual(partial.json()["detail"]["suggestions"], ["Main St, Atlanta, GA 30303, USA"])
        failed = self.patch("a", {"addr": "nowhere"})
        self.assertEqual(failed.status_code, 422)
        detail = failed.json()["detail"]
        self.assertEqual(detail["google_status"], "ZERO_RESULTS")
        self.assertEqual(detail["suggestions"], ["1 Nowhere Ln, Atlanta, GA, USA"])
        self.assertIn("could not be verified", detail["message"])
        self.assertEqual(self.stores.get("p1", "a").addr, "10 Oak St")  # nothing written

    def test_field_rules(self):
        self.assertEqual(self.patch("a", {"store_name": "  "}).status_code, 422)
        self.assertEqual(self.patch("a", {"addr": ""}).status_code, 422)
        bad = self.patch("a", {"owner_email": "x", "outlet_status": "Old", "image_url": "folder",
                               "fields": {"mystery": 1, "screens_wanted": "many"}})
        self.assertEqual(bad.status_code, 422)
        detail = bad.json()["detail"]
        self.assertEqual(set(detail["fields"]), {"owner_email", "outlet_status", "image_url"})
        self.assertEqual(len(detail["errors"]), 5)
        self.assertEqual(self.patch("a", {"committed_dolphin_screens": -1}).status_code, 422)
        self.assertEqual(self.patch("zzz", {"store_name": "x"}).status_code, 404)

    def test_read_only_routing_and_progress_attributes_are_rejected(self):
        for body in ({"external_id": "NEW"}, {"pa": "East"}, {"installer": "Bo"}, {"day": 3}, {"status": "Completed"},
                     {"comment": "x"}, {"screens": []}, {"source_date": "2026-01-01"}):
            with self.subTest(body=body):
                self.assertEqual(self.patch("a", body).status_code, 422)
        stop = self.stores.get("p1", "a")
        self.assertEqual((stop.external_id, stop.pa, stop.installer, stop.comment), ("IBC-1", "", "Ann", ""))


class ScreensTests(StoresApiTestCase):
    def test_put_replaces_the_rows_and_keeps_sent_ids(self):
        keep = self.stores.get("p1", "b").screens[0].id
        body = {"screens": [{"id": keep, "venue_id": "V2", "status": "Delivered"},
                            {"id": "made-up", "stick_number": "S9", "status": "Completed", "has_ceiling_mount": True},
                            {"status": "Completed", "is_dolphin_screen": False}],
                "updated_by": "tech@x"}
        response = self.put_screens("b", body)
        self.assertEqual(response.status_code, 200, response.text)
        stop = response.json()
        ids = [screen["id"] for screen in stop["screens"]]
        self.assertEqual(ids[0], keep)
        self.assertNotIn("made-up", ids)  # only this store's ids are kept; others are minted
        self.assertEqual(len(set(ids)), 3)
        self.assertEqual((stop["status"], stop["updated_by"]), ("Delivered", "tech@x"))  # derived
        self.assertEqual([s["has_ceiling_mount"] for s in stop["screens"]], [False, True, False])

    def test_put_validation(self):
        self.assertEqual(self.put_screens("b", {"screens": []}).status_code, 422)  # at least one row
        self.assertEqual(self.put_screens("b", {"screens": [{"status": "Done"}]}).status_code, 422)
        self.assertEqual(self.put_screens("b", {"screens": [{}], "extra": 1}).status_code, 422)
        keep = self.stores.get("p1", "b").screens[0].id
        twice = {"screens": [{"id": keep}, {"id": keep}]}
        self.assertEqual(self.put_screens("b", twice).status_code, 422)
        self.assertEqual(self.put_screens("zzz", {"screens": [{}]}).status_code, 404)

    def test_screens_write_touches_only_screens_status_and_audit(self):
        writes = []
        original = self.stores.update_fields

        def spy(project_id, uid, changes):
            writes.append(set(changes))
            return original(project_id, uid, changes)

        self.stores.update_fields = spy
        self.put_screens("b", {"screens": [{"status": "Completed"}], "updated_by": "x"})
        self.assertEqual(writes, [{"screens", "status", "updated_by"}])


class ProgressTests(StoresApiTestCase):
    def test_progress_writes_only_progress_fields(self):
        before = self.stores.get("p1", "b")
        response = self.patch("b", {"comment": "done", "additional_task": True, "installer_name": "Bob",
                                    "updated_by": "tech@x"}, "/progress")
        self.assertEqual(response.status_code, 200, response.text)
        after = self.stores.get("p1", "b")
        self.assertEqual((after.comment, after.additional_task, after.installer_name, after.updated_by),
                         ("done", True, "Bob", "tech@x"))
        self.assertEqual((after.installer, after.day, after.addr, after.fields, after.screens, after.status),
                         (before.installer, before.day, before.addr, before.fields, before.screens, before.status))

    def test_progress_no_longer_takes_a_status(self):
        self.assertEqual(self.patch("b", {"status": "Completed"}, "/progress").status_code, 422)  # per screen now
        self.assertEqual(self.patch("b", {}, "/progress").status_code, 422)
        self.assertEqual(self.patch("zzz", {"comment": "x"}, "/progress").status_code, 404)

    def test_progress_and_detail_writes_stay_in_their_groups(self):
        writes = []
        original = self.stores.update_fields

        def spy(project_id, uid, changes):
            writes.append(set(changes))
            return original(project_id, uid, changes)

        self.stores.update_fields = spy
        self.patch("b", {"comment": "x"}, "/progress")
        self.patch("b", {"addr": "99 New St", "city": "Atlanta", "zip": "30303"})
        self.assertEqual(writes[0], {"comment"})
        self.assertFalse(writes[1] & {"status", "screens", "comment", "installer", "day", "seq"})
