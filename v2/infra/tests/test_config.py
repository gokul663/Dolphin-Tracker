"""Run with `cd infra && .venv/bin/python -m unittest discover tests` (pure: no CDK synth)."""
import unittest

from config import EnvConfig, load


class AllowedOriginsTests(unittest.TestCase):
    def test_lists_configured_and_domain_origins_without_duplicates(self):
        cfg = EnvConfig(
            name="dev", retain_data=False, cors_origins=["http://localhost:5173", "https://d1.cloudfront.net/"],
            cloudfront_domain="d1.cloudfront.net", domain_name="tracker.example.com",
        )
        self.assertEqual(
            cfg.allowed_origins(),
            ["http://localhost:5173", "https://d1.cloudfront.net", "https://tracker.example.com"],
        )

    def test_empty_list_fails(self):
        with self.assertRaisesRegex(ValueError, "no CORS origins"):
            EnvConfig(name="prod", retain_data=True).allowed_origins()

    def test_wildcard_fails(self):
        with self.assertRaisesRegex(ValueError, "not an allowed CORS origin"):
            EnvConfig(name="dev", retain_data=False, cors_origins=["*"]).allowed_origins()

    def test_prod_needs_explicit_origins(self):
        with self.assertRaises(ValueError):
            load("prod").allowed_origins()
        self.assertEqual(load("prod", {"cloudfront_domain": "d9.cloudfront.net"}).allowed_origins(),
                         ["https://d9.cloudfront.net"])

    def test_context_overrides_only_known_keys(self):
        cfg = load("dev", {"google_browser_key": "browser-k", "google_map_id": "map-1", "retain_data": "yes",
                           "cloudfront_domain": None})
        self.assertEqual((cfg.google_browser_key, cfg.google_map_id), ("browser-k", "map-1"))
        self.assertFalse(cfg.retain_data)
        self.assertEqual(cfg.cloudfront_domain, load("dev").cloudfront_domain)  # a None override keeps the configured value


if __name__ == "__main__":
    unittest.main()
