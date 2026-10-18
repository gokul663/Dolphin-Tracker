import unittest
from datetime import UTC, datetime

from dolphin_tracker.domain.migration import format_report, is_legacy, legacy_keys, transform_project
from dolphin_tracker.domain.models import ScreenStatus, now_iso

V1_PROJECT = {
    "id": "proj-1",
    "name": "Dallas wave 2",
    "pa": "North",
    "project_type": "offline",
    "installers": ["Ann", "Bo", ""],
    "field_agent": "Fay",
    "pa_percentage": 40,
    "dolphin_percentage": 60.0,
    "store_percentage": None,
    "created_at": "2026-05-01T00:00:00+00:00",
    "stops": [
        {"id": "S1", "store_name": "Alpha", "addr": "1 Main St", "city": "Dallas", "state": "TX", "zip": "75201",
         "lat": 32.78, "lng": -96.8, "installer": "Ann", "day": 1, "pa": "North", "dma": "DAL",
         "venue_code": "V1", "owner_phone": "555-0100", "brand": "Acme", "assigned_region": ""},
        {"id": "S2", "store_name": "Beta", "addr": "2 Elm St", "city": "Dallas", "state": "TX", "zip": "75201",
         "lat": 33.0, "lng": -97.0, "installer": "Ann", "day": 1},  # integral floats: JS prints 33 / -97
        {"id": "S3", "store_name": "Gamma", "addr": "3 Oak St", "city": "Dallas", "state": "TX", "zip": "75201",
         "lat": None, "lng": None, "installer": "Bo", "day": "2"},  # null coords: JS '' vs Python 'None'
        {"id": "S4", "store_name": "Delta", "addr": "4 Pine St", "city": "Dallas", "state": "TX", "zip": "75201",
         "lat": 32.7, "lng": -96.7, "installer": "Ann", "day": 2},
        {"id": "S5", "store_name": "Epsilon", "addr": "Epsilon", "city": "5 Ash St, Dallas", "state": "", "zip": "",
         "geocoded": "5 Ash St, Dallas, TX 75202, USA", "lat": 32.79, "lng": -96.79, "installer": "Ann", "day": 1},
    ],
}

STATES = [
    # S1: written by the page (JS formatting; same as Python for these numbers)
    {"project_id": "proj-1", "stop_key": "atl-route-v2|Ann|S1|1 Main St|32.78|-96.8", "status": "Complete",
     "comment": "done", "additional_task": True, "installer_name": "Annie", "updatedBy": "tech@x",
     "updatedAt": "2026-06-01T10:00:00+00:00", "venue_code": "V1-NEW", "store_name": "Alpha Renamed"},
    # S2: JS integral formatting
    {"project_id": "proj-1", "stop_key": "atl-route-v2|Ann|S2|2 Elm St|33|-97", "status": "Technical Issue",
     "modem": True},
    # S3: JS null formatting
    {"project_id": "proj-1", "stop_key": "atl-route-v2|Bo|S3|3 Oak St||", "status": "Other"},
    # matches nothing (stop was moved to another installer after the state was written)
    {"project_id": "proj-1", "stop_key": "atl-route-v2|Bo|S4|4 Pine St|32.7|-96.7", "status": "Complete"},
]


class LegacyKeyTests(unittest.TestCase):
    def test_js_and_python_spellings(self):
        self.assertEqual(
            legacy_keys({"installer": "A", "id": "S1", "addr": "x", "lat": 33.0, "lng": None}),
            ["atl-route-v2|A|S1|x|33|", "atl-route-v2|A|S1|x|33.0|None"],
        )
        self.assertEqual(len(legacy_keys({"installer": "A", "id": "S1", "addr": "x", "lat": 1.5, "lng": 2.5})), 1)


class TransformTests(unittest.TestCase):
    def setUp(self):
        self.migrated = transform_project(V1_PROJECT, STATES)
        self.by_id = {stop.display_id: stop for stop in self.migrated.stops}

    def test_project_meta(self):
        project = self.migrated.project
        self.assertEqual((project.id, project.name, project.project_type.value), ("proj-1", "Dallas wave 2", "offline"))
        self.assertEqual(project.installers, ["Ann", "Bo"])
        self.assertEqual((project.pa_percentage, project.dolphin_percentage, project.store_percentage), (40, 60, None))
        self.assertEqual((project.stops_per_day, project.stop_count), (8, 5))
        self.assertEqual(project.created_at, "2026-05-01T00:00:00+00:00")
        # First-class attributes are not schema fields any more; only extras (and payee_name, if used) are.
        self.assertEqual([field.key for field in project.field_schema], ["brand"])

    def test_legacy_attributes_become_store_attributes(self):
        s1 = self.by_id["S1"]
        self.assertEqual((s1.pa, s1.dma, s1.owner_phone), ("North", "DAL", "555-0100"))
        self.assertEqual(s1.fields, {"brand": "Acme"})  # only the extra attribute stays in `fields`
        # The venue code (the state's edited one wins) is the IBC# and the screen's venue id (§4.4).
        self.assertEqual((s1.external_id, [screen.venue_id for screen in s1.screens]), ("V1-NEW", ["V1-NEW"]))
        self.assertEqual((self.by_id["S2"].fields, self.by_id["S2"].external_id), ({}, "LEGACY-S2"))

    def test_state_join_all_key_spellings(self):
        s1, s2, s3 = self.by_id["S1"], self.by_id["S2"], self.by_id["S3"]
        self.assertEqual((s1.status, s1.comment, s1.additional_task), (ScreenStatus.COMPLETED, "done", True))
        progress = (s1.installer_name, s1.updated_by, s1.updated_at)
        self.assertEqual(progress, ("Annie", "tech@x", "2026-06-01T10:00:00+00:00"))
        self.assertEqual(s1.store_name, "Alpha Renamed")  # store-name override from progress
        self.assertEqual((s2.status, s2.additional_task), (ScreenStatus.OFFLINE, True))  # modem -> task
        self.assertEqual(s3.status, ScreenStatus.UPCOMING)  # v1 "Other" (STORE-MODEL §4.4)
        self.assertEqual((s3.lat, s3.day), (None, 2))
        self.assertEqual(self.by_id["S4"].status, ScreenStatus.UPCOMING)

    def test_seq_follows_array_order_within_installer_day(self):
        layout = {d: (s.installer, s.day, s.seq) for d, s in self.by_id.items()}
        self.assertEqual(layout, {"S1": ("Ann", 1, 0), "S2": ("Ann", 1, 1), "S3": ("Bo", 2, 0),
                                  "S4": ("Ann", 2, 0), "S5": ("Ann", 1, 2)})

    def test_shifted_address_is_repaired(self):
        s5 = self.by_id["S5"]
        self.assertEqual((s5.addr, s5.city, s5.state, s5.zip), ("5 Ash St", "Dallas", "TX", "75202"))
        self.assertEqual(self.migrated.report.repaired_addresses, 1)

    def test_uids_are_unique_and_stable(self):
        uids = [stop.uid for stop in self.migrated.stops]
        self.assertEqual(len(set(uids)), 5)
        self.assertEqual(uids, [stop.uid for stop in transform_project(V1_PROJECT, STATES).stops])
        self.assertNotIn("atl-route-v2", "".join(uids))

    def test_report_counts_orphans_and_kpi_parity(self):
        report = self.migrated.report
        self.assertEqual((report.stops, report.states, report.matched_states), (5, 4, 3))
        self.assertEqual(report.orphan_states, ["atl-route-v2|Bo|S4|4 Pine St|32.7|-96.7"])
        # v1's dashboard looked up the Python spelling, so it never saw S2's or S3's page-written state.
        self.assertEqual((report.old_kpi.complete, report.old_kpi.offline, report.old_kpi.other), (1, 0, 0))
        # New: S2 Technical Issue -> Offline; S3 Other -> Upcoming (pending, as v1 showed it).
        self.assertEqual((report.new_kpi.complete, report.new_kpi.offline, report.new_kpi.other), (1, 1, 0))
        self.assertFalse(report.kpi_matches)
        text = format_report([report])
        self.assertIn("KPI differs", text)
        self.assertIn("orphan state: atl-route-v2|Bo|S4", text)
        self.assertIn("extra attributes kept as schema fields: brand", text)

    def test_kpi_matches_when_states_use_python_keys(self):
        doc = {**V1_PROJECT, "stops": V1_PROJECT["stops"][:1]}
        report = transform_project(doc, STATES[:1]).report
        self.assertTrue(report.kpi_matches)

    def test_defaults_for_sparse_documents(self):
        migrated = transform_project({"id": "p", "project_type": "bogus", "stops": [{"addr": "x"}]}, [])
        self.assertEqual((migrated.project.name, migrated.project.project_type.value), ("p", "new_installation"))
        self.assertEqual(migrated.stops[0].display_id, "S1")

    def test_installers_derived_from_stops_when_the_doc_has_none(self):
        migrated = transform_project({**V1_PROJECT, "installers": []}, STATES)
        self.assertEqual(migrated.project.installers, ["Ann", "Bo"])  # order of first appearance
        self.assertTrue(migrated.report.derived_installers)
        self.assertEqual(migrated.report.unlisted_installer_stops, 0)
        self.assertIn("installers derived from stops", format_report([migrated.report]))

    def test_stops_on_unlisted_installer_are_reported(self):
        migrated = transform_project({**V1_PROJECT, "installers": ["Ann"]}, STATES)
        self.assertEqual(migrated.project.installers, ["Ann"])
        self.assertFalse(migrated.report.derived_installers)
        self.assertEqual(migrated.report.unlisted_installer_stops, 1)  # S3 on Bo
        self.assertIn("stops on unlisted installer: 1", format_report([migrated.report]))

    def test_day_accepts_float_strings(self):
        first, second = V1_PROJECT["stops"][:2]
        doc = {**V1_PROJECT, "stops": [{**first, "day": "2.0"}, {**second, "day": 3.0}]}
        self.assertEqual([stop.day for stop in transform_project(doc, []).stops], [2, 3])
        bad = {**V1_PROJECT, "stops": [{**V1_PROJECT["stops"][0], "day": "soon"}]}
        self.assertEqual(transform_project(bad, []).stops[0].day, 1)

    def test_mongo_datetimes_become_iso_with_timezone(self):
        doc = {**V1_PROJECT, "created_at": datetime(2026, 5, 1, 9, 30), "updated_at": datetime(2026, 6, 2, tzinfo=UTC)}
        states = [{**STATES[0], "updatedAt": datetime(2026, 6, 1, 10, 0, 5)}]
        migrated = transform_project(doc, states)
        self.assertEqual(migrated.project.created_at, "2026-05-01T09:30:00+00:00")
        self.assertEqual(migrated.project.updated_at, "2026-06-02T00:00:00+00:00")
        self.assertEqual(migrated.stops[0].updated_at, "2026-06-01T10:00:05+00:00")
        self.assertLess(migrated.stops[0].updated_at, now_iso())  # sorts with values the app writes

    def test_v1_statuses_map_per_section_4_4(self):
        s1, s2, s3, s4 = (self.by_id[key] for key in ("S1", "S2", "S3", "S4"))
        self.assertEqual((s1.status, s1.comment), (ScreenStatus.COMPLETED, "done"))
        self.assertEqual((s2.status, s2.comment), (ScreenStatus.OFFLINE, "v1 status: Technical Issue"))
        self.assertEqual(s3.status, ScreenStatus.UPCOMING)  # Other
        self.assertEqual(s4.status, ScreenStatus.UPCOMING)  # no state at all: Incomplete
        self.assertTrue(all(len(stop.screens) == 1 for stop in self.migrated.stops))
        technical = {**STATES[1], "comment": "modem dead"}
        stop = transform_project(V1_PROJECT, [STATES[0], technical]).stops[1]
        self.assertEqual(stop.comment, "modem dead\nv1 status: Technical Issue")

    def test_ibc_falls_back_to_legacy_ids_when_a_venue_code_repeats(self):
        first, second = V1_PROJECT["stops"][:2]
        doc = {**V1_PROJECT, "stops": [{**first, "venue_code": "V9"}, {**second, "venue_code": "v9"},
                                       {**second, "id": "S2", "venue_code": ""}]}
        migrated = transform_project(doc, [])
        self.assertEqual([stop.external_id for stop in migrated.stops], ["V9", "LEGACY-S2", "LEGACY-S2-2"])
        self.assertEqual([stop.screens[0].venue_id for stop in migrated.stops], ["V9", "v9", ""])
        report = migrated.report
        self.assertEqual((report.ids_from_venue_code, report.legacy_ids, report.duplicate_venue_codes),
                         (1, 2, ["V9"]))
        self.assertIn("IBC#: 1 from venue codes, 2 LEGACY-* (repeated venue codes: V9)", format_report([report]))

    def test_report_compares_v1_status_counts_to_derived_statuses(self):
        report = self.migrated.report
        self.assertEqual(report.v1_statuses, {"Complete": 1, "Technical Issue": 1, "Other": 1, "Incomplete": 2})
        self.assertEqual(report.v2_statuses, {"Completed": 1, "Offline": 1, "Upcoming": 3})
        self.assertTrue(report.statuses_match)
        self.assertIn("v2 statuses: Completed 1, Offline 1, Upcoming 3", format_report([report]))
        report.v2_statuses = {"Completed": 1, "Upcoming": 3}  # a lost stop
        self.assertFalse(report.statuses_match)
        self.assertIn("status counts differ", format_report([report]))

    def test_legacy_project_is_recognised(self):
        self.assertTrue(is_legacy("atlanta-default"))
        self.assertFalse(is_legacy("proj-1"))


class ScriptTests(unittest.TestCase):
    def test_requires_connection_settings(self):
        import importlib.util
        from pathlib import Path

        path = Path(__file__).resolve().parents[1] / "scripts" / "migrate_from_mongo.py"
        spec = importlib.util.spec_from_file_location("migrate_from_mongo", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(module.main(["--mongo-url", "", "--db", ""]), 2)
