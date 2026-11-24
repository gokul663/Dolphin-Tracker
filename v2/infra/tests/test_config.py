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


class SignInTests(unittest.TestCase):
    ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_U2DnRTmXT"

    def test_off_until_set(self):
        self.assertEqual(EnvConfig(name="dev", retain_data=False).auth_env(), {})
        self.assertEqual(load("prod").auth_env(), {})

    def test_dev_signs_in_through_the_nexus_pool(self):
        env = load("dev").auth_env()
        self.assertEqual((env["DT_AUTH_MODE"], env["DT_AUTH_ISSUER"], env["DT_AUTH_JWKS_URL"]),
                         ("jwt", self.ISSUER, self.ISSUER + "/.well-known/jwks.json"))
        self.assertRegex(env["DT_AUTH_AUDIENCE"], r"^[a-z0-9]{20,}$")  # a Cognito client ID, not a Google one

    def test_issuer_jwks_and_client_id_turn_it_on(self):
        cfg = EnvConfig(name="dev", retain_data=False, auth_issuer=self.ISSUER,
                        auth_jwks_url=self.ISSUER + "/.well-known/jwks.json", auth_client_id="client123")
        self.assertEqual(cfg.auth_env(), {
            "DT_AUTH_MODE": "jwt", "DT_AUTH_ISSUER": self.ISSUER,
            "DT_AUTH_JWKS_URL": self.ISSUER + "/.well-known/jwks.json", "DT_AUTH_AUDIENCE": "client123",
        })

    def test_half_set_fails(self):
        with self.assertRaisesRegex(ValueError, "auth_jwks_url, auth_client_id"):
            EnvConfig(name="dev", retain_data=False, auth_issuer=self.ISSUER).auth_env()


if __name__ == "__main__":
    unittest.main()
