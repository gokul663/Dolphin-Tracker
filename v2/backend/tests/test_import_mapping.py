"""Import mapping v2 (STORE-MODEL §6) on a fixture built from the user's sample IBC sheet header."""
import csv
import io
import tempfile
import unittest

from dolphin_tracker.api.schemas import ImportResult
from dolphin_tracker.domain.import_mapping import (
    FIELDS,
    IGNORE,
    build_screens,
    check_mapping,
    clean_mapping,
    detect_mapping,
    mark_duplicates,
)
from dolphin_tracker.domain.models import Job, JobStatus, JobType, Project, ProjectType, ScreenStatus
from dolphin_tracker.domain.parsing import normalize_column
from dolphin_tracker.repositories.files import LocalFileStore, result_key
from dolphin_tracker.repositories.memory import InMemoryJobRepository, InMemoryProjectRepository
from dolphin_tracker.services.imports import ImportService
from tests.fakes import FakeGeocoder, geocode_ok

SAMPLE_HEADER = [
    "Date", "IBC#", "STATUS", "Shipment / Device status", "Technician", "Notes", "CMS details added",
    "SITE ACCOUNT Created", "SCREENS added", "DAgent Added", "Google Drive Made", "Renamed in ESPR", "PICTURES ADDED",
    "CMS credentials given", "sent to BO", "payment initiated (only for self install)", "No of Sticks",
    "Stick Number", "Venue ID", "CMS NAME", "Store Name", "Store Address", "Latitude", "Longitude", "City", "State",
    "Zip", "Regional Manager", "Regional Manager email", "Regional Manager phone number", "Store Owner Name",
    "Store Owner Number", "Store Owner Email", "Outlet Status", "Best Contact Time", "Preferred Language",
    "Does the store need TVs?", "How many screens does store want?", "How many TVs are in the store?",
    "TV OR SCREEN", "Confirmed for Mounting (Yes/No/Unsure)", "Service Type", "Preferred Area In Store",
    "Spot Visible From Most Of Store?", "Power Outlet Within 6 Ft of Install Spot",
    "Can Ethernet Be Run To Install Spot", "Is Low-Volume Audio Acceptable", "Is Ceiling Suitable For Mounting?",
    "Ceiling Type", "Approx. Ceiling Height", "Nearest Power Outlet", "Ethernet Cable Route", "Store SSID",
    "Store SSID Password", "Account Program Pictures: Image URL", "Days / Times Cannot Install",
    "Blocked Dates / Notes", "Preferred Install Date/Time", "On-site Contact Name", "On-site Contact Phone",
    "On-Screen Features", "Products / Content to Avoid", "Installation comments", "Installation area",
]


def sheet(*rows: dict[str, str]) -> bytes:
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=SAMPLE_HEADER)
    writer.writeheader()
    for row in rows:
        writer.writerow(row)
    return buffer.getvalue().encode()


ROWS = (
    {  # 0: complete store, two sticks and three venue ids (padded), every typed column filled
        "Date": "10/1/2026", "IBC#": "ibc-101", "STATUS": "Installed", "Shipment / Device status": "delivered",
        "Technician": "self install", "CMS details added": "TRUE", "No of Sticks": "2", "Stick Number": "S1, S2",
        "Venue ID": "V1,V2,V3", "Store Name": "Alpha Mart", "Store Address": "1 Main St", "Latitude": "33.75",
        "Longitude": "-84.39", "City": "Atlanta", "State": "Georgia", "Zip": "30303", "Store Owner Name": "Ann",
        "Store Owner Number": "(404) 555-0100", "Store Owner Email": "ann@alpha.test", "Outlet Status": "new",
        "How many screens does store want?": "3", "How many TVs are in the store?": "2",
        "Confirmed for Mounting (Yes/No/Unsure)": "Unsure", "Spot Visible From Most Of Store?": "Yes",
        "Power Outlet Within 6 Ft of Install Spot": "No", "Ceiling Type": "Drop", "Approx. Ceiling Height": "10ft",
        "Account Program Pictures: Image URL": "https://img.test/a.jpg https://img.test/b.jpg",
        "On-site Contact Phone": "404-555-0199", "Installation comments": "Back office\nby the till",
        "Regional Manager": "Rita",
    },
    {  # 1: STATUS blank → Shipment / Device status; Google fails but the sheet has coordinates
        "IBC#": "IBC-102", "Shipment / Device status": "Shipped", "No of Sticks": "Only 1 Stick",
        "Store Name": "Beta Deli", "Store Address": "9 Lost Rd", "Latitude": "34.1", "Longitude": "-84.2",
        "City": "Marietta", "State": "GA", "Zip": "30060",
    },
    {  # 2: same IBC# as row 0 (different spelling) → duplicate by external_id
        "IBC#": " IBC-101 ", "Store Name": "Alpha Mart again", "Store Address": "500 Elsewhere Ave",
        "City": "Atlanta", "State": "GA", "Zip": "30303",
    },
    {  # 3: new IBC#, same address as row 1 → duplicate by address
        "IBC#": "IBC-104", "Store Name": "Beta Deli (dup)", "Store Address": "9 LOST RD.", "City": "marietta",
        "State": "ga", "Zip": "30060",
    },
    {  # 4: no IBC#, three sticks by count, unusable values flagged
        "STATUS": "on hold", "No of Sticks": "3", "Store Name": "Gamma Gas", "Store Address": "7 Pine Rd",
        "City": "Macon", "State": "GA", "Zip": "31201", "Store Owner Email": "not-an-email",
        "How many screens does store want?": "two",
    },
)

GEOCODES = {
    "1 Main St, Atlanta, GA 30303": geocode_ok("1 Main St", lat=33.749, lng=-84.388),
    "500 Elsewhere Ave, Atlanta, GA 30303": geocode_ok("500 Elsewhere Ave"),
    "7 Pine Rd, Macon, GA 31201": geocode_ok("7 Pine Rd", city="Macon", zip="31201"),
}


class SampleHeaderMappingTests(unittest.TestCase):
    def test_every_listed_header_maps_and_the_rest_are_other_data(self):
        columns = [normalize_column(header) for header in SAMPLE_HEADER]
        mapping = detect_mapping(columns)
        expected = {
            "date": "source_date", "ibc": "external_id", "status": "status",
            "shipment_device_status": "status_fallback", "technician": "installer_name",
            "cms_details_added": "cms_details_added", "no_of_sticks": "screen_count", "stick_number": "stick_numbers",
            "venue_id": "venue_ids", "store_name": "store_name", "store_address": "addr", "latitude": "lat",
            "longitude": "lng", "city": "city", "state": "state", "zip": "zip", "store_owner_name": "owner_name",
            "store_owner_number": "owner_phone", "store_owner_email": "owner_email", "outlet_status": "outlet_status",
            "best_contact_time": "best_contact_time", "preferred_language": "preferred_language",
            "how_many_screens_does_store_want": "committed_dolphin_screens",
            "how_many_tvs_are_in_the_store": "committed_store_tvs", "preferred_area_in_store": "preferred_area",
            "spot_visible_from_most_of_store": "spot_visible",
            "power_outlet_within_6_ft_of_install_spot": "power_within_6ft",
            "can_ethernet_be_run_to_install_spot": "ethernet_possible",
            "is_low_volume_audio_acceptable": "low_volume_audio_ok",
            "is_ceiling_suitable_for_mounting": "ceiling_suitable", "ceiling_type": "ceiling_type",
            "approx_ceiling_height": "ceiling_height", "nearest_power_outlet": "nearest_power_outlet",
            "ethernet_cable_route": "ethernet_route", "store_ssid": "store_ssid",
            "store_ssid_password": "store_ssid_password", "account_program_pictures_image_url": "image_url",
            "blocked_dates_notes": "blocked_dates_notes", "preferred_install_date_time": "preferred_install_datetime",
            "on_site_contact_name": "onsite_contact_name", "on_site_contact_phone": "onsite_contact_phone",
            "products_content_to_avoid": "products_to_avoid", "installation_comments": "installation_notes",
        }
        self.assertEqual({column: mapping[column] for column in expected}, expected)
        other = sorted(column for column, target in mapping.items() if target == FIELDS)
        self.assertIn("confirmed_for_mounting_yes_no_unsure", other)
        self.assertIn("regional_manager", other)
        self.assertEqual(len(other), len(columns) - len(expected))

    def test_saved_choices_win_and_each_target_is_taken_once(self):
        mapping = detect_mapping(["store", "store_name", "address", "notes"], {"notes": "installation_notes"})
        self.assertEqual(mapping, {"store": "store_name", "store_name": FIELDS, "address": "addr",
                                   "notes": "installation_notes"})
        ignored = detect_mapping(["address", "notes"], {"notes": IGNORE, "address": "not-a-field"})
        self.assertEqual(ignored, {"address": "addr", "notes": IGNORE})  # unknown saved targets fall back to §6

    def test_check_and_clean_a_client_mapping(self):
        self.assertEqual(check_mapping({"a": "addr", "b": "dma"}), [])
        errors = check_mapping({"a": "dma", "b": "dma", "c": "nope"})
        self.assertEqual(len(errors), 3)  # double use, unknown target, no address
        self.assertEqual(clean_mapping({"a": "addr", "b": "nope", "c": FIELDS}), {"a": "addr", "c": FIELDS})

    def test_screens_from_lists_or_count(self):
        rows = build_screens({"stick_numbers": "S1, S2", "venue_ids": "V1,V2,V3"}, ScreenStatus.SHIPPED)
        self.assertEqual([(r["stick_number"], r["venue_id"], r["status"]) for r in rows],
                         [("S1", "V1", "Shipped"), ("S2", "V2", "Shipped"), ("", "V3", "Shipped")])
        self.assertEqual(len(build_screens({"screen_count": "Only 1 Stick"}, ScreenStatus.UPCOMING)), 1)
        self.assertEqual(len(build_screens({"screen_count": "4"}, ScreenStatus.UPCOMING)), 4)
        self.assertEqual(len(build_screens({"screen_count": "0"}, ScreenStatus.UPCOMING)), 1)  # at least one
        self.assertEqual(len(build_screens({}, ScreenStatus.UPCOMING)), 1)

    def test_duplicates_by_external_id_first_then_address(self):
        rows = [
            {"index": 0, "external_id": "A", "addr": "1 Main", "city": "X", "state": "GA", "zip": "1"},
            {"index": 1, "external_id": "a ", "addr": "2 Other", "city": "X", "state": "GA", "zip": "1"},
            {"index": 2, "external_id": "B", "addr": "1 MAIN", "city": "x", "state": "ga", "zip": "1"},
            {"index": 3, "external_id": "", "addr": "", "city": "X", "state": "GA", "zip": "1"},
            {"index": 4, "external_id": "", "addr": "", "city": "X", "state": "GA", "zip": "1"},
        ]
        mark_duplicates(rows)
        self.assertEqual([(r["duplicate_of"], r["duplicate_reason"]) for r in rows],
                         [(None, ""), (0, "external_id"), (0, "address"), (None, ""), (None, "")])


class SampleSheetImportTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.files = LocalFileStore(tmp.name)
        self.jobs = InMemoryJobRepository()
        self.projects = InMemoryProjectRepository()

    def run_import(self, raw: bytes, project_id: str | None = None) -> dict:
        self.files.put_bytes("uploads/j1/ibc.csv", raw)
        payload = {"upload_key": "uploads/j1/ibc.csv", "filename": "ibc.csv"}
        self.jobs.put(Job(id="j1", type=JobType.IMPORT_PARSE, status=JobStatus.RUNNING, project_id=project_id,
                          payload=payload))
        ImportService(self.jobs, self.files, FakeGeocoder(geocodes=GEOCODES), self.projects).run("j1", {})
        job = self.jobs.get("j1")
        self.assertEqual(job.status, JobStatus.SUCCEEDED, job.message)
        result = self.files.get_json(result_key("j1"))
        ImportResult.model_validate(result)
        return result

    def test_sample_sheet(self):
        result = self.run_import(sheet(*ROWS))
        self.assertEqual(result["summary"], {"total": 5, "valid": 3, "needs_review": 2, "invalid": 0,
                                             "duplicates": 2})
        self.assertEqual(self.jobs.get("j1").message, "3 valid, 2 to review, 0 invalid, 2 duplicate")
        alpha, beta, alpha_again, beta_dup, gamma = result["rows"]

        self.assertEqual((alpha["external_id"], alpha["store_name"], alpha["state"]), ("IBC-101", "Alpha Mart", "GA"))
        self.assertEqual((alpha["venue_status"], alpha["venue_status_valid"]), ("Completed", True))  # STATUS wins
        self.assertEqual(alpha["installer_name"], "self install")
        self.assertEqual([(s["stick_number"], s["venue_id"]) for s in alpha["screens"]],
                         [("S1", "V1"), ("S2", "V2"), ("", "V3")])
        details = alpha["details"]
        self.assertEqual(details["source_date"], "2026-10-01")
        self.assertEqual((details["committed_dolphin_screens"], details["committed_store_tvs"]), (3, 2))
        self.assertEqual((details["spot_visible"], details["power_within_6ft"]), (True, False))
        self.assertNotIn("ethernet_possible", details)  # the sheet's cell was blank; the column exists though
        self.assertEqual((details["cms_details_added"], details["outlet_status"]), (True, "New"))
        self.assertEqual(details["installation_notes"], "Back office\nby the till")
        self.assertEqual(alpha["problems"], {})
        self.assertEqual(alpha["fields"]["confirmed_for_mounting_yes_no_unsure"], "Unsure")
        self.assertEqual(alpha["fields"]["regional_manager"], "Rita")
        self.assertEqual((alpha["coordinates_source"], alpha["lat"]), ("geocode", 33.749))

        self.assertEqual((beta["venue_status"], len(beta["screens"])), ("Shipped", 1))  # fallback status column
        self.assertEqual((beta["status"], beta["coordinates_source"], beta["lat"], beta["lng"]),
                         ("needs_review", "sheet", 34.1, -84.2))
        self.assertIn("sheet's coordinates", beta["error"])

        self.assertEqual((alpha_again["duplicate_of"], alpha_again["duplicate_reason"]), (0, "external_id"))
        self.assertEqual((beta_dup["duplicate_of"], beta_dup["duplicate_reason"]), (1, "address"))

        self.assertEqual((gamma["venue_status"], gamma["venue_status_valid"], gamma["venue_status_raw"]),
                         ("Upcoming", False, "on hold"))
        self.assertEqual(len(gamma["screens"]), 3)
        self.assertEqual(set(gamma["problems"]), {"external_id", "owner_email", "committed_dolphin_screens"})
        self.assertIsNone(gamma["details"]["committed_dolphin_screens"])

    def test_the_projects_saved_mapping_is_used_for_its_next_sheet(self):
        self.projects.put(Project(id="p1", name="P", project_type=ProjectType.OFFLINE,
                                  import_mappings={"notes": "installation_notes", "regional_manager": IGNORE}))
        result = self.run_import(sheet({**ROWS[0], "Notes": "use the side door"}), project_id="p1")
        row = result["rows"][0]
        self.assertEqual(result["mapping"]["notes"], "installation_notes")
        self.assertEqual(row["details"]["installation_notes"], "use the side door")  # saved choice beat §6
        self.assertNotIn("regional_manager", row["fields"])  # ignored
