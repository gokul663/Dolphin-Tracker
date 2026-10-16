from dolphin_tracker.domain.models import Project, ProjectType, RoutingStatus, Stop
from dolphin_tracker.domain.schema import default_field_schema
from tests.test_projects_api import ProjectApiTestCase


def existing_stop(uid: str, display: str, installer: str, day: int, seq: int, state: str = "GA", **extra) -> Stop:
    return Stop(
        uid=uid, display_id=display, store_name=f"Store {uid}", addr=f"{uid} Main St", city="Atlanta", state=state,
        zip="30303", installer=installer, day=day, seq=seq, lat=33.7, lng=-84.4, **extra,
    )


def new_stop(name: str, addr: str, state: str = "GA", **fields) -> dict:
    return {"store_name": name, "addr": addr, "city": "Atlanta", "state": state, "zip": "30303", "fields": fields}


class AppendTests(ProjectApiTestCase):
    def setUp(self):
        super().setUp()
        self.projects.put(
            Project(
                id="p1", name="Seeded", pa="North", project_type=ProjectType.OFFLINE, installers=["Ann", "Bo"],
                stops_per_day=2, field_schema=default_field_schema(), stop_count=4,
            )
        )
        self.stores.put_many(
            "p1",
            [
                existing_stop("a", "S1", "Ann", 1, 0, fields={"venue_code": "V1"}),
                existing_stop("b", "S7", "Ann", 1, 1),
                existing_stop("c", "S3", "Ann", 2, 0),
                existing_stop("d", "legacy-9", "Bo", 1, 0, state="TX"),
            ],
        )

    def append(self, stops: list[dict], **body):
        return self.client.post("/api/projects/p1/stores/append", json={"stops": stops, **body})

    def test_dedupe_against_existing_and_within_batch(self):
        response = self.append(
            [
                new_stop("Dup venue", "1 Other Rd", venue_code="v1"),  # venue code match, case-insensitive
                new_stop("Dup address", "B Main St"),  # normalised address of stop b
                new_stop("Fresh", "77 New Rd"),
                new_stop("Fresh again", "77 new rd."),  # duplicate inside the batch
            ]
        )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual((body["appended"], body["total"]), (1, 5))
        self.assertEqual([(s["addr"], s["reason"]) for s in body["skipped"]],
                         [("1 Other Rd", "duplicate"), ("B Main St", "duplicate"), ("77 new rd.", "duplicate")])
        self.assertEqual(body["skipped"][0]["venue_code"], "v1")

    def test_greedy_placement_and_display_ids(self):
        body = self.append([new_stop("N1", "1 New Rd"), new_stop("N2", "2 New Rd"), new_stop("N3", "3 New Rd")]).json()
        self.assertEqual(body["appended"], 3)
        new = sorted((s for s in self.stores.list_all("p1") if s.uid not in "abcd"), key=lambda s: s.display_id)
        self.assertEqual([s.display_id for s in new], ["S10", "S8", "S9"])  # continues after max S7
        placed = {s.display_id: (s.installer, s.day, s.seq) for s in new}
        # Bo has the fewest stops; his only day is TX, so the GA stop opens day 2. Then Bo (2) vs Ann (3) -> Bo,
        # day 2 has room. Then Ann (3) vs Bo (3) -> Ann (first); day 2 (S3) has room.
        self.assertEqual(placed, {"S8": ("Bo", 2, 0), "S9": ("Bo", 2, 1), "S10": ("Ann", 2, 1)})
        project = self.projects.get("p1")
        self.assertEqual(project.stop_count, 7)

    def test_status_fields_and_pa_merge(self):
        stop = {**new_stop("N1", "1 New Rd", pa="South", dma="ATL"), "initial_status": "Complete"}
        self.append([stop], pa="East, North").json()
        added = next(s for s in self.stores.list_all("p1") if s.store_name == "N1")
        self.assertEqual((added.status.value, added.fields), ("Complete", {"pa": "South", "dma": "ATL"}))
        self.assertEqual(self.projects.get("p1").pa, "East, North, South")

    def test_errors(self):
        self.assertEqual(self.append([]).status_code, 422)
        bad = self.append([new_stop("", "1 Rd"), new_stop("ok", "2 Rd", owner_email="nope")])
        self.assertEqual(bad.status_code, 422)
        self.assertEqual([row["index"] for row in bad.json()["detail"]["stops"]], [0, 1])
        building = {"routing_status": RoutingStatus.BUILDING}
        self.projects._items["p1"] = self.projects.get("p1").model_copy(update=building)
        self.assertEqual(self.append([new_stop("N", "1 Rd")]).status_code, 409)
        self.projects._items["p1"] = self.projects.get("p1").model_copy(
            update={"routing_status": RoutingStatus.READY, "installers": []}
        )
        self.assertEqual(self.append([new_stop("N", "1 Rd")]).status_code, 422)
        self.assertEqual(self.client.post("/api/projects/nope/stores/append",
                                          json={"stops": [new_stop("N", "1 Rd")]}).status_code, 404)


class DeleteAndPatchTests(ProjectApiTestCase):
    def setUp(self):
        super().setUp()
        self.project_id = self.create_project()["project"]["id"]

    def test_delete_requires_exact_name(self):
        path = f"/api/projects/{self.project_id}"
        self.assertEqual(self.client.delete(path, params={"confirm": "atlanta refresh"}).status_code, 400)
        self.assertEqual(self.client.delete(path).status_code, 400)
        self.assertEqual(self.client.delete(path, params={"confirm": "Atlanta refresh"}).status_code, 204)
        self.assertEqual(self.client.get(path).status_code, 404)
        self.assertEqual(self.stores.list_all(self.project_id), [])
        self.assertEqual(self.client.delete("/api/projects/nope", params={"confirm": "x"}).status_code, 404)

    def patch(self, body: dict):
        return self.client.patch(f"/api/projects/{self.project_id}", json=body)

    def test_patch_metadata_cap_and_schema(self):
        tier = {"key": "tier", "label": "Tier", "type": "select", "options": ["A", "B"]}
        schema = [*(f.model_dump(mode="json") for f in default_field_schema()), tier]
        response = self.patch({"name": " Renamed ", "stops_per_day": 30, "store_percentage": None,
                               "field_schema": schema})
        self.assertEqual(response.status_code, 200, response.text)
        project = response.json()
        values = (project["name"], project["stops_per_day"], project["store_percentage"])
        self.assertEqual(values, ("Renamed", 30, None))
        self.assertEqual(project["field_schema"][-1]["options"], ["A", "B"])
        self.assertEqual(project["installers"], ["Ann", "Bo"])

    def test_patch_rejections(self):
        cases = [
            {"installers": ["X"]},  # installer endpoints only
            {"routing_status": "ready"},
            {"stops_per_day": 0},
            {"pa_percentage": None},
            {"name": "  "},
            {"field_schema": [{"key": "addr", "label": "Address"}]},
            {},
        ]
        for body in cases:
            self.assertEqual(self.patch(body).status_code, 422, body)

    def test_patch_optimistic_version(self):
        version = self.client.get(f"/api/projects/{self.project_id}").json()["version"]
        self.assertEqual(self.patch({"pa": "South", "expected_version": version}).status_code, 200)
        self.assertEqual(self.patch({"pa": "West", "expected_version": version}).status_code, 409)
        self.assertEqual(self.client.patch("/api/projects/nope", json={"pa": "x"}).status_code, 404)
