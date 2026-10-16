import csv
import io
import unittest

from fastapi.testclient import TestClient

from dolphin_tracker.api.app import create_app
from dolphin_tracker.api.deps import get_geocoder, get_project_repository, get_store_repository
from dolphin_tracker.domain.models import FieldDef, FieldType, Project, ProjectType, Stop, StopStatus
from dolphin_tracker.domain.schema import default_field_schema
from dolphin_tracker.repositories.memory import InMemoryProjectRepository, InMemoryStoreRepository
from tests.fakes import FakeGeocoder, geocode_ok

SCHEMA = [*default_field_schema(), FieldDef(key="screens", label="Screens", type=FieldType.NUMBER)]


def seed_stops() -> list[Stop]:
    rows = [
        # uid, display, name, addr, city, zip, status, installer, day, fields, comment, lat
        ("a", "S1", "Bravo Mart", "10 Oak St", "Atlanta", "30303", "Complete", "Ann", 1, {"dma": "ATL", "screens": 2},
         "", 33.7),
        ("b", "S2", "alpha cafe", "5 Elm St", "Decatur", "30030", "Incomplete", "Bo", 2, {"dma": "ATL", "screens": 10},
         "call owner", 33.8),
        ("c", "S10", "Charlie Gas", "1 Pine Rd", "Macon", "31201", "Technical Issue", "Ann", 2, {"dma": "MCN"}, "",
         None),
        ("d", "S3", "Delta Deli", "7 Ash Ave", "Atlanta", "30303", "Incomplete", "", 1, {}, "", 33.75),
    ]
    return [
        Stop(
            uid=uid, display_id=display, store_name=name, addr=addr, city=city, state="GA", zip=zip_code,
            status=status, installer=installer, day=day, fields=fields, comment=comment,
            lat=lat, lng=None if lat is None else -84.4, updated_at=f"2026-10-0{index + 1}T00:00:00+00:00",
        )
        for index, (uid, display, name, addr, city, zip_code, status, installer, day, fields, comment, lat)
        in enumerate(rows)
    ]


class StoresApiTests(unittest.TestCase):
    def setUp(self):
        self.projects = InMemoryProjectRepository()
        self.projects.put(Project(id="p1", name="P", project_type=ProjectType.OFFLINE, installers=["Ann", "Bo"],
                                  field_schema=SCHEMA))
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

    def uids(self, **params) -> list[str]:
        response = self.client.get("/api/projects/p1/stores", params={"limit": 200, **params})
        self.assertEqual(response.status_code, 200, response.text)
        return [stop["uid"] for stop in response.json()["items"]]

    # ---- list -----------------------------------------------------------------------------------------------

    def test_default_sort_is_store_name_case_insensitive(self):
        self.assertEqual(self.uids(), ["b", "a", "c", "d"])
        self.assertEqual(self.uids(dir="desc"), ["d", "c", "a", "b"])

    def test_sort_keys(self):
        self.assertEqual(self.uids(sort="display_id"), ["a", "b", "d", "c"])  # natural: S10 after S3
        self.assertEqual(self.uids(sort="day"), ["a", "d", "b", "c"])  # ties keep display order
        self.assertEqual(self.uids(sort="updated_at", dir="desc"), ["d", "c", "b", "a"])
        self.assertEqual(self.uids(sort="installer"), ["a", "c", "b", "d"])  # blank installer last
        self.assertEqual(self.uids(sort="fields.screens"), ["a", "b", "d", "c"])  # blanks last, display order
        self.assertEqual(self.uids(sort="fields.screens", dir="desc"), ["b", "a", "d", "c"])  # blanks still last

    def test_bad_sort_is_400(self):
        for params in ({"sort": "lat"}, {"sort": "fields.nope"}):
            self.assertEqual(self.client.get("/api/projects/p1/stores", params=params).status_code, 400)
        self.assertEqual(self.client.get("/api/projects/p1/stores", params={"dir": "up"}).status_code, 422)

    def test_filters_and_search(self):
        self.assertEqual(self.uids(status="Incomplete"), ["b", "d"])
        self.assertEqual(sorted(self.uids(status=["Complete", "Technical Issue"])), ["a", "c"])
        self.assertEqual(self.uids(installer="Ann"), ["a", "c"])
        self.assertEqual(self.uids(installer=""), ["d"])  # unassigned
        self.assertEqual(self.uids(q="atlanta"), ["a", "d"])  # city
        self.assertEqual(self.uids(q="MCN"), ["c"])  # fields values
        self.assertEqual(self.uids(q="owner"), ["b"])  # comment
        self.assertEqual(self.uids(q="31201"), ["c"])  # zip
        self.assertEqual(self.uids(q="s10"), ["c"])  # display id
        self.assertEqual(self.uids(q="atlanta", status="Incomplete"), ["d"])
        self.assertEqual(self.client.get("/api/projects/p1/stores", params={"status": "Nope"}).status_code, 422)

    def test_cursor_pagination(self):
        first = self.client.get("/api/projects/p1/stores", params={"limit": 3}).json()
        self.assertEqual(len(first["items"]), 3)
        second = self.client.get("/api/projects/p1/stores", params={"limit": 3, "cursor": first["next_cursor"]}).json()
        self.assertEqual([s["uid"] for s in second["items"]], ["d"])
        self.assertIsNone(second["next_cursor"])
        self.assertEqual(self.client.get("/api/projects/p1/stores", params={"cursor": "%%"}).status_code, 400)
        self.assertEqual(self.client.get("/api/projects/p1/stores", params={"limit": 0}).status_code, 422)

    def test_unknown_project_is_404(self):
        for path in ("", "/pins", "/export.csv", "/a"):
            self.assertEqual(self.client.get(f"/api/projects/nope/stores{path}").status_code, 404, path)

    # ---- pins, get, export ----------------------------------------------------------------------------------

    def test_pins_are_located_stops_only_and_filtered(self):
        pins = self.client.get("/api/projects/p1/stores/pins").json()
        self.assertEqual({pin["uid"] for pin in pins}, {"a", "b", "d"})
        self.assertEqual(set(pins[0]), {"uid", "lat", "lng", "status", "store_name", "installer", "day"})
        self.assertEqual([p["uid"] for p in self.client.get("/api/projects/p1/stores/pins",
                                                            params={"status": "Complete"}).json()], ["a"])

    def test_get_one(self):
        self.assertEqual(self.client.get("/api/projects/p1/stores/a").json()["store_name"], "Bravo Mart")
        self.assertEqual(self.client.get("/api/projects/p1/stores/zzz").status_code, 404)

    def test_export_csv(self):
        self.stores.update_fields("p1", "a", {"comment": "=HYPERLINK(\"x\")"})
        response = self.client.get("/api/projects/p1/stores/export.csv", params={"installer": "Ann"})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("text/csv"))
        self.assertIn("attachment", response.headers["content-disposition"])
        rows = list(csv.reader(io.StringIO(response.text)))
        header = rows[0]
        self.assertEqual(header[:3], ["ID", "Store Name", "Address"])
        self.assertIn("Owner Phone", header)
        self.assertIn("Screens", header)
        self.assertEqual(header[-6:], ["Status", "Comment", "Additional Task", "Installer Name", "Updated By",
                                       "Updated At"])
        self.assertEqual([row[0] for row in rows[1:]], ["S1", "S10"])
        self.assertEqual(rows[1][header.index("Comment")], "'=HYPERLINK(\"x\")")  # formula neutralised
        self.assertEqual(rows[1][header.index("Screens")], "2")

    # ---- PATCH details --------------------------------------------------------------------------------------

    def patch(self, uid: str, body: dict, suffix: str = ""):
        return self.client.patch(f"/api/projects/p1/stores/{uid}{suffix}", json=body)

    def test_detail_edit_without_address_change_skips_geocoding(self):
        response = self.patch("a", {"store_name": " Bravo Market ", "fields": {"owner_phone": "555-010-0100"}})
        self.assertEqual(response.status_code, 200, response.text)
        stop = response.json()
        self.assertEqual(stop["store_name"], "Bravo Market")
        self.assertEqual(stop["fields"], {"dma": "ATL", "screens": 2, "owner_phone": "555-010-0100"})
        self.assertFalse(stop["route_stale"])
        self.assertEqual(self.geocoder.calls, [])
        self.assertEqual(self.patch("a", {"addr": "10 Oak St"}).json()["lat"], 33.7)  # same address: no geocode
        self.assertEqual(self.geocoder.calls, [])

    def test_address_change_geocodes_and_marks_route_stale(self):
        stop = self.patch("a", {"addr": "99 New St"}).json()
        self.assertEqual((stop["addr"], stop["lat"], stop["lng"]), ("99 New St", 33.9, -84.1))
        self.assertEqual(stop["geocoded"], "99 New St, Atlanta, GA 30303, USA")
        self.assertTrue(stop["route_stale"])
        self.assertEqual((stop["installer"], stop["day"], stop["status"]), ("Ann", 1, "Complete"))  # untouched

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

    def test_detail_validation(self):
        self.assertEqual(self.patch("a", {"store_name": "  "}).status_code, 422)
        self.assertEqual(self.patch("a", {"addr": ""}).status_code, 422)
        bad = self.patch("a", {"fields": {"owner_email": "x", "mystery": 1, "screens": "many"}})
        self.assertEqual(bad.status_code, 422)
        self.assertEqual(len(bad.json()["detail"]["errors"]), 3)
        self.assertEqual(self.patch("a", {"installer": "Bo"}).status_code, 200)  # unknown keys ignored by the model
        self.assertEqual(self.stores.get("p1", "a").installer, "Ann")
        self.assertEqual(self.patch("zzz", {"store_name": "x"}).status_code, 404)

    # ---- PATCH progress -------------------------------------------------------------------------------------

    def test_progress_writes_only_progress_fields(self):
        before = self.stores.get("p1", "b")
        response = self.patch("b", {"status": "Complete", "comment": "done", "additional_task": True,
                                    "installer_name": "Bob", "updated_by": "tech@x"}, "/progress")
        self.assertEqual(response.status_code, 200, response.text)
        after = self.stores.get("p1", "b")
        self.assertEqual((after.status, after.comment, after.additional_task, after.installer_name, after.updated_by),
                         (StopStatus.COMPLETE, "done", True, "Bob", "tech@x"))
        self.assertEqual((after.installer, after.day, after.seq, after.addr, after.fields),
                         (before.installer, before.day, before.seq, before.addr, before.fields))

    def test_progress_validation(self):
        self.assertEqual(self.patch("b", {}, "/progress").status_code, 422)
        self.assertEqual(self.patch("b", {"status": "Done"}, "/progress").status_code, 422)
        self.assertEqual(self.patch("zzz", {"comment": "x"}, "/progress").status_code, 404)

    def test_progress_write_never_contains_other_groups(self):
        writes = []
        original = self.stores.update_fields

        def spy(project_id, uid, changes):
            writes.append(set(changes))
            return original(project_id, uid, changes)

        self.stores.update_fields = spy
        self.patch("b", {"status": "Other", "comment": "x"}, "/progress")
        self.patch("b", {"addr": "99 New St", "city": "Atlanta", "zip": "30303"})
        self.assertEqual(writes[0], {"status", "comment"})
        self.assertFalse(writes[1] & {"status", "comment", "installer", "day", "seq"})
