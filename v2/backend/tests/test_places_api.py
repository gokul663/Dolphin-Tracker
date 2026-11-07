import unittest

import boto3
from fastapi.testclient import TestClient
from moto import mock_aws

from dolphin_tracker.api.app import create_app
from dolphin_tracker.api.deps import get_geocoder
from dolphin_tracker.config import Settings, get_settings, resolve_google_server_key
from tests.fakes import FakeGeocoder, geocode_ok


class PlacesApiTests(unittest.TestCase):
    def setUp(self):
        self.geocoder = FakeGeocoder(
            geocodes={"1 Main St, Atlanta": geocode_ok("1 Main St")},
            autocomplete={"2 Elm": ["2 Elm St, Atlanta, GA, USA", "2 Elm Ave, Decatur, GA, USA"]},
        )
        self.app = create_app()
        self.app.dependency_overrides[get_geocoder] = lambda: self.geocoder
        settings = Settings(app_env="test", google_browser_key="browser-k", google_map_id="map-1")
        self.app.dependency_overrides[get_settings] = lambda: settings
        self.client = TestClient(self.app)

    def test_validate_success(self):
        response = self.client.get("/api/places/validate", params={"address": " 1 Main St, Atlanta "})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["ok"])
        parts = (body["addr"], body["city"], body["state"], body["zip"])
        self.assertEqual(parts, ("1 Main St", "Atlanta", "GA", "30303"))
        self.assertEqual(body["lat"], 33.75)
        self.assertEqual(self.geocoder.calls, [("geocode", "1 Main St, Atlanta")])

    def test_validate_failure_falls_back_to_autocomplete_suggestions(self):
        body = self.client.get("/api/places/validate", params={"address": "2 Elm"}).json()
        self.assertFalse(body["ok"])
        self.assertEqual(body["status"], "ZERO_RESULTS")
        self.assertEqual(body["suggestions"], ["2 Elm St, Atlanta, GA, USA", "2 Elm Ave, Decatur, GA, USA"])

    def test_validate_requires_an_address(self):
        self.assertEqual(self.client.get("/api/places/validate").status_code, 422)
        self.assertEqual(self.client.get("/api/places/validate", params={"address": ""}).status_code, 422)

    def test_search_lists_the_store_then_the_places_at_its_address(self):
        store = {"place_id": "p1", "name": "Sunset Gas And Grill", "formatted": "Sunset, TX 76270", "lat": 33.45,
                 "lng": -97.77, "addr": "", "city": "Sunset", "state": "TX", "zip": "76270"}
        nearby = {**store, "place_id": "p2", "name": "Dollar General", "formatted": "345 TX-101, Sunset, TX 76270"}
        self.geocoder.searches = {
            "Sunset Gas & Grill, 101 S Council Rd, Sunset, TX": [store],
            "101 S Council Rd, Sunset, TX": [store, nearby],  # the store again: listed once
        }
        params = {"address": "101 S Council Rd, Sunset, TX", "name": "Sunset Gas & Grill"}
        body = self.client.get("/api/places/search", params=params).json()
        self.assertEqual([hit["name"] for hit in body], ["Sunset Gas And Grill", "Dollar General"])
        self.assertEqual((body[0]["lat"], body[0]["lng"]), (33.45, -97.77))
        self.assertEqual(self.client.get("/api/places/search").status_code, 422)

    def test_autocomplete(self):
        body = self.client.get("/api/places/autocomplete", params={"q": "2 Elm"}).json()
        self.assertEqual(len(body["suggestions"]), 2)
        self.assertEqual(self.client.get("/api/places/autocomplete").json(), {"suggestions": []})

    def test_maps_config_returns_browser_key_only(self):
        body = self.client.get("/api/config/maps").json()
        self.assertEqual(body, {"google_maps_browser_key": "browser-k", "google_map_id": "map-1"})

    def test_default_field_schema(self):
        self.assertEqual(self.client.get("/api/config/field-schema").json(), [])  # STORE-MODEL: all first-class

    def test_store_field_registry(self):
        fields = self.client.get("/api/config/store-fields").json()
        self.assertEqual([field["name"] for field in fields[:3]], ["external_id", "store_name", "addr"])
        by_name = {field["name"]: field for field in fields}
        self.assertEqual((by_name["external_id"]["editable"], by_name["external_id"]["required"]), (False, True))
        self.assertEqual(by_name["outlet_status"]["options"], ["New", "Existing"])
        self.assertEqual(by_name["spot_visible"]["kind"], "tristate")
        groups = list(dict.fromkeys(field["group"] for field in fields))
        self.assertEqual(groups, ["Identity & address", "Contacts", "Installation", "WiFi", "Pictures", "Site notes",
                                  "Site checklist", "Screens"])

    def test_endpoints_are_documented(self):
        paths = self.client.get("/api/openapi.json").json()["paths"]
        for path in ("/api/config/maps", "/api/places/validate", "/api/places/autocomplete"):
            self.assertIn("200", paths[path]["get"]["responses"])


def bare_settings(**values) -> Settings:
    """Settings without the developer's backend/.env, whose real keys would win over the test values."""
    return Settings(_env_file=None, **values)


class ServerKeyTests(unittest.TestCase):
    def test_direct_value_wins(self):
        self.assertEqual(resolve_google_server_key(bare_settings(google_server_key="direct")), "direct")
        self.assertEqual(resolve_google_server_key(bare_settings()), "")

    @mock_aws
    def test_reads_secure_string_from_ssm(self):
        boto3.client("ssm", region_name="us-east-1").put_parameter(
            Name="/dt/test/key", Value="from-ssm\n", Type="SecureString"
        )
        self.assertEqual(resolve_google_server_key(bare_settings(google_server_key_param="/dt/test/key")), "from-ssm")
