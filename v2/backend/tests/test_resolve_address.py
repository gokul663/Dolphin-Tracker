"""Checking an address the way Google Maps would: Geocoding, then Autocomplete's suggestions (resolve_address)."""
import unittest

from dolphin_tracker.services.geocoding import (
    house_number,
    resolve_address,
    same_address,
    same_name,
    state_highway_variant,
    street_key,
    zip_of,
)
from tests.fakes import FakeGeocoder

TYPED = "101 W State Road 60, Plant City, Florida 33567"
ROAD_ONLY = {"ok": True, "partial": True, "formatted": "W State Rd 60, Florida 33567, USA", "lat": 27.9, "lng": -82.0,
             "suggestions": ["W State Rd 60, Florida 33567, USA"]}
SUGGESTIONS = [
    "101 State Road 60, Plant City, Florida 33567, USA",
    "101 West State Road 60, Plant City, Florida 33567, USA",
    "101 State Road 60 East, Plant City, Florida 33567, USA",
]


def details(exact: bool) -> dict:
    return {"ok": True, "exact": exact, "partial": False, "formatted": "101 W State Rd 60, Plant City, FL 33567, USA",
            "lat": 27.9368, "lng": -82.1468, "addr": "101 West State Road 60", "city": "Plant City", "state": "FL",
            "zip": "33567", "suggestions": []}


class SameAddressTests(unittest.TestCase):
    def test_abbreviations_are_spelled_out(self):
        self.assertEqual(street_key("101 W. State Rd 60, Plant City"), "101 west state road 60")
        self.assertTrue(same_address(TYPED, SUGGESTIONS[1]))
        self.assertTrue(same_address(TYPED, SUGGESTIONS[0]))  # State Road 60 in any spelling is FL-60
        self.assertFalse(same_address(TYPED, "101 West State Road 60, Lakeland, Florida 33801, USA"))  # other ZIP
        self.assertFalse(same_address("W State Road 60, Plant City", "W State Road 60, Plant City"))  # no number
        self.assertEqual(house_number("1709 W State Rd 60"), "1709")
        self.assertEqual(zip_of("10777 E Highway 40"), "")  # a five-digit house number is not a ZIP
        self.assertEqual(zip_of("10777 E Highway 40, Silver Springs, FL 34488-1234"), "34488")


class ResolveAddressTests(unittest.TestCase):
    def geocoder(self, exact: bool | None) -> FakeGeocoder:
        return FakeGeocoder(
            geocodes={TYPED: ROAD_ONLY},
            autocomplete={TYPED: SUGGESTIONS},
            details={} if exact is None else {SUGGESTIONS[1]: details(exact)},
        )

    def test_partial_geocode_shows_what_google_maps_suggests(self):
        result = resolve_address(self.geocoder(None), TYPED)
        self.assertTrue(result["partial"])
        self.assertEqual(result["suggestions"], SUGGESTIONS)  # not just Geocoding's road

    def test_the_matching_suggestion_verifies_when_google_knows_the_house(self):
        result = resolve_address(self.geocoder(exact=True), TYPED)
        self.assertEqual((result["ok"], result["partial"], result["matched_by"]), (True, False, "autocomplete"))
        self.assertEqual((result["lat"], result["lng"], result["city"]), (27.9368, -82.1468, "Plant City"))

    def test_road_only_suggestions_leave_it_partial_with_the_suggestions(self):
        result = resolve_address(self.geocoder(exact=False), TYPED)
        self.assertTrue(result["partial"])
        self.assertEqual(result["suggestions"], SUGGESTIONS)

    def test_an_answer_without_the_typed_house_number_is_not_verified(self):
        geocoder = FakeGeocoder(geocodes={"10 Oak Rd, Ocala, FL": {"ok": True, "partial": False, "addr": "Oak Road",
                                                                    "formatted": "Oak Rd, Ocala, FL, USA"}})
        self.assertTrue(resolve_address(geocoder, "10 Oak Rd, Ocala, FL")["partial"])

    def test_the_business_by_name_places_it(self):
        typed = "10777 E Highway 40, Silver Springs, Florida 34488"
        place = {"ok": True, "name": "Forest Food & Fuel", "formatted": "10777 FL-40, Silver Springs, FL 34488, USA",
                 "lat": 29.2143, "lng": -81.9747}
        geocoder = FakeGeocoder(geocodes={typed: {"ok": True, "partial": True, "formatted": "Silver Springs, FL"}},
                                places={f"Forest Food & Fuel, {typed}": place})
        result = resolve_address(geocoder, typed, "Forest Food & Fuel")
        self.assertEqual((result["partial"], result["matched_by"], result["lat"]), (False, "places", 29.2143))
        self.assertEqual((result["addr"], result["city"], result["zip"]), ("10777 FL-40", "Silver Springs", "34488"))
        wrong = FakeGeocoder(geocodes=geocoder.geocodes,
                             places={f"Forest Food & Fuel, {typed}": {**place, "formatted": "1709 FL-40, Ocala, FL"}})
        self.assertTrue(resolve_address(wrong, typed, "Forest Food & Fuel")["partial"])  # another house: no

    def test_a_state_highway_is_tried_as_google_writes_it(self):
        typed = "10777 E Highway 40, Silver Springs, Florida 34488"
        exact = {"ok": True, "partial": False, "addr": "10777 FL-40", "formatted": "10777 FL-40, Silver Springs, FL",
                 "lat": 29.2142, "lng": -81.9748}
        geocoder = FakeGeocoder(geocodes={typed: {"ok": True, "partial": True, "formatted": "Silver Springs, FL"},
                                          "10777 FL-40, Silver Springs, Florida 34488": exact})
        result = resolve_address(geocoder, typed)
        self.assertEqual((result["partial"], result["matched_by"]), (False, "state_highway"))

    def test_a_match_in_another_zip_is_not_this_store(self):
        typed = "11931 N US Hwy 301, Thonotosassa, Florida 33592"
        elsewhere = "11931 N US Hwy 301, Thonotosassa, FL, USA"  # the suggestion's text has no ZIP...
        geocoder = FakeGeocoder(
            geocodes={typed: {"ok": True, "partial": True, "formatted": "Thonotosassa, FL, USA"}},
            autocomplete={typed: [elsewhere]},
            details={elsewhere: {**details(True), "addr": "11931 North US Highway 301", "zip": "32113",
                                 "formatted": "11931 N US Hwy 301, Citra, FL 32113, USA"}},  # ...but it is in Citra
        )
        self.assertTrue(resolve_address(geocoder, typed)["partial"])
        wrong_zip = FakeGeocoder(geocodes={"1 Main St, Ocala, FL 34470": {
            "ok": True, "partial": False, "addr": "1 Main St", "zip": "32601", "formatted": "1 Main St, Gainesville"}})
        self.assertTrue(resolve_address(wrong_zip, "1 Main St, Ocala, FL 34470")["partial"])

    def test_a_business_google_knows_only_by_town_is_placed_by_its_name(self):
        typed = "101 S Council Rd, Sunset, Texas 76270"
        place = {"ok": True, "name": "Sunset Gas And Grill", "formatted": "Sunset, TX 76270", "lat": 33.45,
                 "lng": -97.77}
        geocoder = FakeGeocoder(geocodes={typed: {"ok": True, "partial": True, "formatted": "Sunset, TX 76270, USA"}},
                                places={f"Sunset Gas & Grill, {typed}": place, f"Chevron, {typed}": place})
        result = resolve_address(geocoder, typed, "Sunset Gas & Grill")
        self.assertEqual((result["partial"], result["matched_by"], result["lat"]), (False, "places", 33.45))
        self.assertTrue(resolve_address(geocoder, typed, "Chevron")["partial"])  # another name: not this store
        far = {**place, "formatted": "Chico, TX 76431"}
        geocoder.places[f"Sunset Gas & Grill, {typed}"] = far
        self.assertTrue(resolve_address(geocoder, typed, "Sunset Gas & Grill")["partial"])  # another town

    def test_suggestions_in_another_town_are_left_out(self):
        typed = "101 S Council Rd, Sunset, Texas 76270"
        near = "101 S Council Dr, Sunset, Texas 76270, USA"
        geocoder = FakeGeocoder(geocodes={typed: {"ok": True, "partial": True, "formatted": "Sunset, TX"}},
                                autocomplete={typed: ["Texas 101, Chico, TX, USA", near]})
        self.assertEqual(resolve_address(geocoder, typed)["suggestions"], [near])

    def test_store_names(self):
        self.assertTrue(same_name("Sunset Gas & Grill", "Sunset Gas And Grill"))
        self.assertTrue(same_name("Shell", "Shell Gas Station"))
        self.assertFalse(same_name("Shell", "Chevron"))

    def test_state_highway_spellings(self):
        cases = {
            "10777 E Highway 40, Silver Springs, Florida 34488": "10777 FL-40, Silver Springs, Florida 34488",
            "5 SR-40, Ocala, FL 34470": "5 FL-40, Ocala, FL 34470",
            "9 State Road 60, Plant City, FL 33567": "9 FL-60, Plant City, FL 33567",
            "12 US Highway 41, Tampa, FL 33601": "",  # a US highway: Google reads it as typed
            "7 County Road 5, Foo, FL 33333": "",
            "10 Main St, Atlanta, GA 30303": "",
        }
        for typed, variant in cases.items():
            with self.subTest(typed=typed):
                self.assertEqual(state_highway_variant(typed), variant)

    def test_an_exact_geocode_needs_nothing_more(self):
        geocoder = FakeGeocoder(geocodes={"1 Main St": {"ok": True, "partial": False, "formatted": "1 Main St"}})
        self.assertFalse(resolve_address(geocoder, "1 Main St")["partial"])
        self.assertEqual([kind for kind, _ in geocoder.calls], ["geocode"])  # no extra requests
