import unittest

from dolphin_tracker.domain.addresses import apply_parsed_address, duplicate_key, parse_us_formatted_address


class AddressTests(unittest.TestCase):
    def test_repairs_shifted_google_place_address(self):
        stop = {
            "store_name": "My Beer Store 12",
            "addr": "My Beer Store",
            "city": "12 3102 Harwood Rd Ste 100, Bedford",
            "state": "",
            "zip": "76021",
            "geocoded": "My Beer Store, 12 3102 Harwood Rd Ste 100, Bedford, TX 76021, USA",
        }
        self.assertTrue(apply_parsed_address(stop))
        self.assertEqual(stop["addr"], "12 3102 Harwood Rd Ste 100")
        self.assertEqual(stop["city"], "Bedford")
        self.assertEqual(stop["state"], "TX")
        self.assertEqual(stop["zip"], "76021")

    def test_parses_standard_google_formatted_address(self):
        parsed = parse_us_formatted_address("3102 Harwood Rd Ste 100, Bedford, TX 76021, USA")
        self.assertEqual(parsed, {"addr": "3102 Harwood Rd Ste 100", "city": "Bedford", "state": "TX", "zip": "76021"})

    def test_leaves_complete_addresses_alone(self):
        stop = {
            "addr": "1 Main St", "city": "Dallas", "state": "TX", "zip": "75201",
            "geocoded": "1 Main St, Dallas, TX 75201",
        }
        self.assertFalse(apply_parsed_address(stop))

    def test_duplicate_key_prefers_venue_code(self):
        self.assertEqual(duplicate_key({"venue_code": " V-1 ", "addr": "x"}), "venue|v-1")
        self.assertEqual(
            duplicate_key({"addr": "1 Main St.", "city": "Dallas", "state": "TX"}), "addr|1 main st|dallas|tx"
        )
        self.assertEqual(duplicate_key({}), "")
