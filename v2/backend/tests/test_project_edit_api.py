from dolphin_tracker.domain.errors import ConflictError
from dolphin_tracker.domain.models import FieldDef, Project, ProjectType, RoutingStatus, Stop
from dolphin_tracker.domain.validation import FIELDS_BY_NAME
from dolphin_tracker.services.routing import RoutingService
from tests.test_projects_api import NoopInvoker, ProjectApiTestCase


def existing_stop(uid: str, display: str, installer: str, day: int, seq: int, state: str = "GA", **extra) -> Stop:
    return Stop(
        uid=uid, display_id=display, store_name=f"Store {uid}", addr=f"{uid} Main St", city="Atlanta", state=state,
        zip="30303", installer=installer, day=day, seq=seq, lat=33.7, lng=-84.4, **extra,
    )


def new_stop(name: str, addr: str, state: str = "GA", *, external_id: str | None = None, **values) -> dict:
    """Store attributes go on the stop; anything else is an extra field."""
    attributes = {key: value for key, value in values.items() if key in FIELDS_BY_NAME}
    fields = {key: value for key, value in values.items() if key not in FIELDS_BY_NAME}
    return {"external_id": external_id or f"IBC-{name}", "store_name": name, "addr": addr, "city": "Atlanta",
            "state": state, "zip": "30303", **attributes, "fields": fields}


class AppendTests(ProjectApiTestCase):
    def setUp(self):
        super().setUp()
        self.projects.put(
            Project(
                id="p1", name="Seeded", pa="North", project_type=ProjectType.OFFLINE, installers=["Ann", "Bo"],
                stops_per_day=2, field_schema=[FieldDef(key="venue_code", label="Venue Code")], stop_count=4,
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

    def test_dedupe_by_external_id_then_address_against_existing_and_within_batch(self):
        self.stores._items["p1"]["a"] = self.stores.get("p1", "a").model_copy(update={"external_id": "IBC-A"})
        response = self.append(
            [
                new_stop("Dup id", "1 Other Rd", external_id=" ibc-a "),  # IBC# of stop a, normalised
                new_stop("Dup address", "B Main St"),  # normalised address of stop b
                new_stop("Fresh", "77 New Rd"),
                new_stop("Fresh again", "77 new rd."),  # duplicate address inside the batch
                new_stop("Same id", "88 Far Rd", external_id="IBC-Fresh"),  # duplicate IBC# inside the batch
                new_stop("Venue only", "5 Venue Rd", venue_code="v1"),  # a venue code match no longer counts
            ]
        )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual((body["appended"], body["total"]), (2, 6))
        self.assertEqual(
            [(s["index"], s["external_id"], s["reason"]) for s in body["skipped"]],
            [(0, "IBC-A", "external_id"), (1, "IBC-DUP ADDRESS", "address"), (3, "IBC-FRESH AGAIN", "address"),
             (4, "IBC-FRESH", "external_id")],
        )
        added = {stop.store_name: stop for stop in self.stores.list_all("p1") if stop.uid not in "abcd"}
        self.assertEqual(set(added), {"Fresh", "Venue only"})
        self.assertEqual(added["Fresh"].external_id, "IBC-FRESH")

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
        stop = {**new_stop("N1", "1 New Rd", pa="South", dma="ATL"), "initial_status": "Completed"}
        self.append([stop], pa="East, North").json()
        added = next(s for s in self.stores.list_all("p1") if s.store_name == "N1")
        self.assertEqual((added.status.value, added.pa, added.dma, added.fields), ("Completed", "South", "ATL", {}))
        self.assertEqual(self.projects.get("p1").pa, "East, North, South")

    def test_other_sheet_columns_join_the_schema(self):
        self.assertEqual(self.append([new_stop("N1", "1 New Rd", venue_code="V9", brand="Acme")]).status_code, 200)
        self.assertEqual([field.key for field in self.projects.get("p1").field_schema], ["venue_code", "brand"])
        added = next(s for s in self.stores.list_all("p1") if s.store_name == "N1")
        self.assertEqual(added.fields, {"venue_code": "V9", "brand": "Acme"})

    def test_errors(self):
        self.assertEqual(self.append([]).status_code, 422)
        bad = self.append([new_stop("", "1 Rd"), new_stop("ok", "2 Rd", owner_email="nope")])
        self.assertEqual(bad.status_code, 422)
        self.assertEqual([row["index"] for row in bad.json()["detail"]["stops"]], [0, 1])
        building = {"routing_status": RoutingStatus.BUILDING}
        self.projects._items["p1"] = self.projects.get("p1").model_copy(update=building)
        self.assertEqual(self.append([new_stop("N", "1 Rd")]).status_code, 409)
        self.projects._items["p1"] = self.projects.get("p1").model_copy(update={"routing_status": RoutingStatus.READY})
        self.assertEqual(self.client.post("/api/projects/nope/stores/append",
                                          json={"stops": [new_stop("N", "1 Rd")]}).status_code, 404)


    def test_append_holds_the_routing_slot_against_a_build_enqueued_meanwhile(self):
        routing = RoutingService(self.projects, self.stores, self.jobs, NoopInvoker())
        original = self.stores.put_many
        outcome = {}

        def put_then_try_a_build(project_id, stops):
            try:
                routing.enqueue(project_id, "recluster")
            except ConflictError as exc:
                outcome["build"] = str(exc)
            return original(project_id, stops)

        self.stores.put_many = put_then_try_a_build
        self.assertEqual(self.append([new_stop("N1", "1 New Rd")]).status_code, 200)
        self.assertEqual(outcome["build"], "Routing is already in progress for this project")
        project = self.projects.get("p1")
        self.assertEqual((project.routing_status, project.routing_job_id), (RoutingStatus.READY, ""))  # released

    def test_append_saves_the_import_mapping_on_the_project(self):
        self.projects._items["p1"] = self.projects.get("p1").model_copy(update={"import_mappings": {"a": "dma"}})
        mapping = {"notes": "installation_notes", "code": "nope", "store": "store_name"}
        self.assertEqual(self.append([new_stop("N1", "1 New Rd")], import_mapping=mapping).status_code, 200)
        saved = self.projects.get("p1").import_mappings
        self.assertEqual(saved, {"a": "dma", "notes": "installation_notes", "store": "store_name"})  # merged, cleaned

    def test_append_without_installers_leaves_the_stores_unrouted(self):
        self.projects._items["p1"] = self.projects.get("p1").model_copy(update={"installers": []})
        self.assertEqual(self.append([new_stop("N1", "1 Rd"), new_stop("N2", "2 Rd")]).status_code, 200)
        new = sorted((s for s in self.stores.list_all("p1") if s.uid not in "abcd"), key=lambda s: s.display_id)
        self.assertEqual([(s.display_id, s.installer, s.day, s.seq) for s in new], [("S8", "", 1, 0), ("S9", "", 1, 1)])

    def test_append_releases_the_slot_when_it_fails(self):
        self.assertEqual(self.append([new_stop("N", "1 Rd", owner_email="nope")]).status_code, 422)
        self.assertEqual(self.projects.get("p1").routing_job_id, "")

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
        schema = [tier]
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
            {"pa": None},
            {"name": "  "},
            {"field_schema": [{"key": "addr", "label": "Address"}]},
            {},
        ]
        for body in cases:
            self.assertEqual(self.patch(body).status_code, 422, body)

    def test_patch_clears_the_split_percentages(self):
        response = self.patch({"pa_percentage": None, "dolphin_percentage": None})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual((response.json()["pa_percentage"], response.json()["dolphin_percentage"]), (None, None))

    def test_patch_optimistic_version(self):
        version = self.client.get(f"/api/projects/{self.project_id}").json()["version"]
        self.assertEqual(self.patch({"pa": "South", "expected_version": version}).status_code, 200)
        self.assertEqual(self.patch({"pa": "West", "expected_version": version}).status_code, 409)
        self.assertEqual(self.client.patch("/api/projects/nope", json={"pa": "x"}).status_code, 404)
