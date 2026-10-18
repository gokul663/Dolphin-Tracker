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

    def test_autocomplete(self):
        body = self.client.get("/api/places/autocomplete", params={"q": "2 Elm"}).json()
        self.assertEqual(len(body["suggestions"]), 2)
        self.assertEqual(self.client.get("/api/places/autocomplete").json(), {"suggestions": []})

    def test_maps_config_returns_browser_key_only(self):
        body = self.client.get("/api/config/maps").json()
        self.assertEqual(body, {"google_maps_browser_key": "browser-k", "google_map_id": "map-1"})

    def test_default_field_schema(self):
        body = self.client.get("/api/config/field-schema").json()
        self.assertEqual([field["key"] for field in body][:3], ["pa", "venue_type", "dma"])
        self.assertEqual(len(body), 8)

    def test_endpoints_are_documented(self):
        paths = self.client.get("/api/openapi.json").json()["paths"]
        for path in ("/api/config/maps", "/api/places/validate", "/api/places/autocomplete"):
            self.assertIn("200", paths[path]["get"]["responses"])


class ServerKeyTests(unittest.TestCase):
    def test_direct_value_wins(self):
        self.assertEqual(resolve_google_server_key(Settings(google_server_key="direct")), "direct")
        self.assertEqual(resolve_google_server_key(Settings()), "")

    @mock_aws
    def test_reads_secure_string_from_ssm(self):
        boto3.client("ssm", region_name="us-east-1").put_parameter(
            Name="/dt/test/key", Value="from-ssm\n", Type="SecureString"
        )
        self.assertEqual(resolve_google_server_key(Settings(google_server_key_param="/dt/test/key")), "from-ssm")
