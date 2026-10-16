import unittest

from dolphin_tracker.services.imports import ImportService


class ImportServiceParseTests(unittest.TestCase):
    def test_maps_known_columns_and_keeps_extras(self):
        raw = (
            b"Store Name,Address,PA,Status,Owner Phone\n"
            b'Store A,"1 Main St, Dallas, TX 75201",North,complete,555-0100\n'
            b"Store B,2 Elm St,North,weird,\n"
        )
        parsed = ImportService.parse("sites.csv", raw)
        self.assertEqual(parsed.address_column, "address")
        self.assertEqual(parsed.store_column, "store_name")
        self.assertEqual(parsed.extra_columns, ["owner_phone"])
        self.assertEqual(parsed.pa_names, ["North"])
        first, second = parsed.rows
        self.assertEqual((first.status, first.status_valid), ("Complete", True))
        self.assertEqual(first.extra, {"owner_phone": "555-0100"})
        self.assertEqual((second.status, second.status_valid, second.status_raw), ("Incomplete", False, "weird"))

    def test_missing_address_column_is_an_error(self):
        with self.assertRaises(ValueError):
            ImportService.parse("sites.csv", b"store_name\nStore A\n")
