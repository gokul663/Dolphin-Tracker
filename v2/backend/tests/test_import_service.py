import tempfile
import unittest

from dolphin_tracker.api.schemas import ImportResult
from dolphin_tracker.domain.import_mapping import MappedRow
from dolphin_tracker.domain.models import Job, JobStatus, JobType
from dolphin_tracker.repositories.files import LocalFileStore, result_key
from dolphin_tracker.repositories.memory import InMemoryJobRepository
from dolphin_tracker.services.imports import ImportService, verify_row
from tests.fakes import FakeGeocoder, geocode_ok


class ImportServiceParseTests(unittest.TestCase):
    def test_maps_known_columns_and_keeps_extras(self):
        raw = (
            b"Store Name,Address,PA,Status,Owner Phone,Brand\n"
            b'Store A,"1 Main St, Dallas, TX 75201",North,complete,555-0100,Acme\n'
            b"Store B,2 Elm St,North,weird,,\n"
        )
        parsed = ImportService.parse("sites.csv", raw)
        self.assertEqual(parsed.column_for("addr"), "address")
        self.assertEqual(parsed.column_for("store_name"), "store_name")
        self.assertEqual(parsed.extra_columns, ["brand"])
        self.assertEqual(parsed.pa_names, ["North"])
        first, second = parsed.rows
        self.assertEqual((first.addr, first.city, first.state, first.zip), ("1 Main St", "Dallas", "TX", "75201"))
        self.assertEqual((first.status, first.status_valid), ("Completed", True))
        self.assertEqual((first.details, first.fields), ({"owner_phone": "555-0100"}, {"brand": "Acme"}))
        self.assertEqual((second.status, second.status_valid, second.status_raw), ("Upcoming", False, "weird"))

    def test_saved_mapping_is_applied_first(self):
        parsed = ImportService.parse("s.csv", b"address,code,brand\n1 Main St,IBC-1,Acme\n", {"code": "external_id"})
        self.assertEqual(parsed.mapping, {"address": "addr", "code": "external_id", "brand": ""})
        self.assertEqual(parsed.rows[0].external_id, "IBC-1")

    def test_missing_address_column_is_an_error(self):
        with self.assertRaises(ValueError):
            ImportService.parse("sites.csv", b"store_name\nStore A\n")


class VerifyRowTests(unittest.TestCase):
    """v1 status rules (AGENT-HANDOFF §3.4)."""

    def row(self, address: str, store: str = "") -> MappedRow:
        return MappedRow(index=3, address=address, addr=address, store_name=store, details={"dma": "ATL"})

    def test_geocode_and_places_ok_is_valid_100(self):
        geocoder = FakeGeocoder(
            geocodes={"1 Main St": geocode_ok("1 Main St")},
            places={"Shop, 1 Main St": {"ok": True, "name": "Shop", "formatted": "1 Main Street, Atlanta, GA"}},
        )
        result = verify_row(self.row("1 Main St", "Shop"), geocoder)
        self.assertEqual((result["status"], result["confidence"]), ("valid", 100))
        self.assertEqual(result["verified_by"], ["geocoding", "places"])
        self.assertEqual(result["place_name"], "Shop")
        # The route address comes from geocoding, never from the Places hit.
        self.assertEqual(result["addr"], "1 Main St")
        self.assertEqual(result["formatted"], "1 Main St, Atlanta, GA 30303, USA")
        self.assertEqual(result["details"]["dma"], "ATL")

    def test_a_place_at_another_house_number_confirms_nothing(self):
        geocoder = FakeGeocoder(
            geocodes={"1 Main St": geocode_ok("1 Main St")},
            places={"Shop, 1 Main St": {"ok": True, "name": "Assisted Living", "formatted": "1709 Main St"}},
        )
        result = verify_row(self.row("1 Main St", "Shop"), geocoder)
        self.assertEqual((result["status"], result["confidence"], result["place_name"]), ("valid", 70, ""))
        self.assertEqual(result["verified_by"], ["geocoding"])

    def test_the_store_by_name_places_a_road_only_address(self):
        typed = "10777 E Highway 40"
        geocoder = FakeGeocoder(
            geocodes={typed: {"ok": True, "partial": True, "formatted": "Silver Springs, FL", "lat": 1, "lng": 2}},
            places={f"Forest Food & Fuel, {typed}": {
                "ok": True, "name": "Forest Food & Fuel", "lat": 29.2, "lng": -81.9,
                "formatted": "10777 FL-40, Silver Springs, FL 34488, USA",
            }},
        )
        result = verify_row(self.row(typed, "Forest Food & Fuel"), geocoder)
        self.assertEqual((result["status"], result["confidence"], result["lat"]), ("valid", 100, 29.2))
        self.assertEqual((result["verified_by"], result["place_name"]), (["places"], "Forest Food & Fuel"))
        self.assertEqual([kind for kind, _ in geocoder.calls].count("find_place"), 1)  # not asked twice

    def test_geocode_only_is_valid_70(self):
        result = verify_row(self.row("1 Main St"), FakeGeocoder(geocodes={"1 Main St": geocode_ok("1 Main St")}))
        self.assertEqual((result["status"], result["confidence"], result["verified_by"]), ("valid", 70, ["geocoding"]))
        self.assertEqual(result["place_name"], "")

    def test_partial_is_needs_review_40(self):
        geocoder = FakeGeocoder(geocodes={"Main St": geocode_ok("Main St", partial=True)})
        result = verify_row(self.row("Main St"), geocoder)
        self.assertEqual((result["status"], result["confidence"]), ("needs_review", 40))
        self.assertIn("Google could not find this house number", result["error"])
        self.assertIsNotNone(result["lat"])

    def test_geocode_failure_is_needs_review_0_with_autocomplete(self):
        geocoder = FakeGeocoder(autocomplete={"nowhere": ["1 Nowhere Rd, GA, USA"]})
        result = verify_row(self.row("nowhere"), geocoder)
        self.assertEqual((result["status"], result["confidence"]), ("needs_review", 0))
        self.assertEqual(result["suggestions"], ["1 Nowhere Rd, GA, USA"])
        self.assertEqual(result["error"], "Could not geocode address")
        self.assertIsNone(result["lat"])

    def test_the_business_is_looked_up_when_geocoding_fails(self):
        # Google may know a store only by its name (no street address): searching the business is the way to it.
        geocoder = FakeGeocoder()
        verify_row(self.row("nowhere", "Shop"), geocoder)
        self.assertIn(("find_place", "Shop, nowhere"), geocoder.calls)

    def test_places_still_confirms_a_partial_match(self):
        geocoder = FakeGeocoder(geocodes={"Main St": geocode_ok("Main St", partial=True)})
        verify_row(self.row("Main St", "Shop"), geocoder)
        self.assertIn(("find_place", "Shop, Main St"), geocoder.calls)

    def test_blank_address_is_invalid_without_google_calls(self):
        geocoder = FakeGeocoder()
        result = verify_row(self.row("   "), geocoder)
        self.assertEqual((result["status"], result["error"]), ("invalid", "Missing address"))
        self.assertEqual(geocoder.calls, [])

    def test_result_rows_have_a_stable_shape(self):
        keys = set(verify_row(self.row(""), FakeGeocoder()))
        self.assertEqual(
            keys,
            {
                "index", "address", "store_name", "external_id", "pa", "status", "confidence", "verified_by",
                "formatted", "addr", "city", "state", "zip", "lat", "lng", "coordinates_source", "place_name",
                "suggestions", "error", "venue_status", "venue_status_valid", "venue_status_raw", "installer_name",
                "details", "screens", "problems", "duplicate_of", "duplicate_reason", "fields",
            },
        )


class ProgressSpyJobs(InMemoryJobRepository):
    def __init__(self):
        super().__init__()
        self.progress: list[int] = []

    def set_status(self, job_id, status, *, progress=None, message="", expected_status=None):
        if progress is not None:
            self.progress.append(progress)
        return super().set_status(job_id, status, progress=progress, message=message, expected_status=expected_status)


class ImportRunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.files = LocalFileStore(self.tmp.name)
        self.jobs = ProgressSpyJobs()

    def _job(self, csv: bytes, filename: str = "sites.csv") -> str:
        key = f"uploads/j1/{filename}"
        self.files.put_bytes(key, csv)
        payload = {"upload_key": key, "filename": filename}
        self.jobs.put(Job(id="j1", type=JobType.IMPORT_PARSE, status=JobStatus.RUNNING, payload=payload))
        return "j1"

    def test_end_to_end_result_and_progress(self):
        lines = ["Store Name,Address,PA,Status,DMA,Owner Phone"]
        geocodes = {}
        for i in range(25):
            lines.append(f"Store {i},{i} Main St,North,complete,ATL,555-01{i:02d}")
            geocodes[f"{i} Main St"] = geocode_ok(f"{i} Main St", lat=33.7 + i / 1000)
        lines.append("Blank,,South,,ATL,")
        lines.append("Lost,1 Nowhere,South,bogus,ATL,")
        job_id = self._job("\n".join(lines).encode())
        ImportService(self.jobs, self.files, FakeGeocoder(geocodes=geocodes)).run(job_id, {"job_id": job_id})

        job = self.jobs.get(job_id)
        self.assertEqual((job.status, job.progress, job.result_key), (JobStatus.SUCCEEDED, 100, result_key(job_id)))
        self.assertEqual(job.message, "25 valid, 1 to review, 1 invalid")
        self.assertEqual(self.jobs.progress[:2], [1, 5])
        self.assertEqual(self.jobs.progress[2:], [5 + 90 * 10 // 27, 5 + 90 * 20 // 27])  # every 10 rows
        self.assertEqual(self.jobs.history[job_id], [JobStatus.RUNNING, JobStatus.SUCCEEDED])

        result = self.files.get_json(result_key(job_id))
        ImportResult.model_validate(result)  # the documented §3.4 contract the frontend type is generated from
        self.assertEqual(
            result["summary"], {"total": 27, "valid": 25, "needs_review": 1, "invalid": 1, "duplicates": 0}
        )
        self.assertEqual(result["address_column"], "address")
        self.assertEqual(result["store_column"], "store_name")
        self.assertEqual(result["extra_columns"], [])  # DMA and Owner Phone are store attributes now
        self.assertEqual(result["pa_names"], ["North", "South"])
        self.assertEqual([row["index"] for row in result["rows"]], list(range(27)))  # input order kept
        first = result["rows"][0]
        self.assertEqual((first["details"], first["fields"]), ({"dma": "ATL", "owner_phone": "555-0100"}, {}))
        self.assertEqual((first["venue_status"], first["venue_status_valid"]), ("Completed", True))
        lost = result["rows"][26]
        status = (lost["venue_status"], lost["venue_status_valid"], lost["venue_status_raw"])
        self.assertEqual(status, ("Upcoming", False, "bogus"))

    def test_redelivered_event_does_not_rerun_the_import(self):
        job_id = self._job(b"address\n1 Main St\n")
        geocoder = FakeGeocoder(geocodes={"1 Main St": geocode_ok("1 Main St")})
        service = ImportService(self.jobs, self.files, geocoder)
        service.run(job_id, {"job_id": job_id})
        service.run(job_id, {"job_id": job_id})  # at-least-once delivery
        self.assertEqual([kind for kind, _ in geocoder.calls].count("geocode"), 1)
        self.assertEqual(self.jobs.history[job_id], [JobStatus.RUNNING, JobStatus.SUCCEEDED])

    def test_run_without_a_key_warns_in_the_job_message(self):
        class NoKey(FakeGeocoder):
            enabled = False

        job_id = self._job(b"address\n1 Main St\n")
        ImportService(self.jobs, self.files, NoKey()).run(job_id, {"job_id": job_id})
        job = self.jobs.get(job_id)
        self.assertEqual(job.status, JobStatus.SUCCEEDED)
        self.assertIn("no Google key configured", job.message)

    def test_unparseable_file_fails_the_job(self):
        job_id = self._job(b"store_name\nOnly a name\n")
        ImportService(self.jobs, self.files, FakeGeocoder()).run(job_id, {"job_id": job_id})
        job = self.jobs.get(job_id)
        self.assertEqual((job.status, job.message), (JobStatus.FAILED, "Missing 'address' column"))
        self.assertFalse(self.files.exists(result_key(job_id)))

    def test_missing_upload_fails_the_job(self):
        self.jobs.put(Job(id="j2", type=JobType.IMPORT_PARSE, payload={"upload_key": "uploads/j2/x.csv"}))
        ImportService(self.jobs, self.files, FakeGeocoder()).run("j2", {"job_id": "j2"})
        job = self.jobs.get("j2")
        self.assertEqual(job.status, JobStatus.FAILED)
        self.assertIn("uploads/j2/x.csv", job.message)

    def test_geocoder_crash_fails_the_job(self):
        class Broken(FakeGeocoder):
            def geocode(self, address):
                raise RuntimeError("quota exceeded")

        job_id = self._job(b"address\n1 Main St\n")
        ImportService(self.jobs, self.files, Broken()).run(job_id, {"job_id": job_id})
        job = self.jobs.get(job_id)
        self.assertEqual((job.status, job.message), (JobStatus.FAILED, "Import failed: quota exceeded"))

    def test_missing_job_is_a_no_op(self):
        ImportService(self.jobs, self.files, FakeGeocoder()).run("ghost", {"job_id": "ghost"})
        self.assertIsNone(self.jobs.get("ghost"))
