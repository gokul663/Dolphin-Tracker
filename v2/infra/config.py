"""Per-environment settings for the CDK app. Keep this file free of secrets."""
from dataclasses import dataclass, field, replace


@dataclass(frozen=True)
class EnvConfig:
    name: str
    retain_data: bool
    cors_origins: list[str] = field(default_factory=list)
    # Write Tracker's log entries to the shared log collection in MongoDB (insert only). Off until the team is
    # ready to log from Tracker for real: every entry saved while it is on lands in the production log collection.
    cms_log_write: bool = False
    domain_name: str | None = None          # e.g. "tracker.example.com"; None = CloudFront default domain
    certificate_arn: str | None = None      # ACM cert in us-east-1 for the domain above
    cloudfront_domain: str | None = None    # e.g. "d1234abcd.cloudfront.net", once the Web stack has deployed
    log_retention_days: int = 30
    # The API Lambda. Memory also sets its CPU share: 2048 MB parses a project's stores about twice as fast as
    # 1024, for about the same cost per request (it finishes sooner).
    api_memory_mb: int = 2048
    # Instances kept started and ready (provisioned concurrency), so opening a page does not wait about 3 s for a
    # cold start. Opening a project needs two or three at once. Billed around the clock, by memory: roughly $17 a
    # month each at 2048 MB. 0 = none (every instance starts on demand).
    api_warm_instances: int = 0
    # Public by design (Maps JS runs in the browser); restrict it by HTTP referrer in Google Cloud. Not a secret,
    # but it can also come from `-c google_browser_key=...` so it need not be committed.
    google_browser_key: str = ""
    google_map_id: str = ""  # Google Cloud Map ID (public); the user creates it
    # Sign-in through the shared Dolphin Nexus login (its Cognito user pool). While all three are empty the API has
    # no login (everyone is a Super Admin): set all three to turn it on. None is a secret.
    auth_issuer: str = ""     # https://cognito-idp.us-east-1.amazonaws.com/us-east-1_U2DnRTmXT
    auth_jwks_url: str = ""   # <auth_issuer>/.well-known/jwks.json
    auth_client_id: str = ""  # the "dolphin-tracker" app client: output TrackerClientId of the Nexus deploy

    @property
    def prefix(self) -> str:
        return f"DolphinTracker-{self.name.capitalize()}"

    def allowed_origins(self) -> list[str]:
        """Origins for S3 and API CORS: the configured list plus https:// for the custom and CloudFront domains.

        Never `*`. An empty list fails synth: there is no safe default to fall back to."""
        origins = list(self.cors_origins)
        origins += [f"https://{host}" for host in (self.domain_name, self.cloudfront_domain) if host]
        origins = list(dict.fromkeys(origin.rstrip("/") for origin in origins))
        if "*" in origins:
            raise ValueError(f"[{self.name}] '*' is not an allowed CORS origin; list the origins explicitly")
        if not origins:
            raise ValueError(
                f"[{self.name}] no CORS origins: set cors_origins, domain_name or cloudfront_domain in infra/config.py"
            )
        return origins

    def auth_env(self) -> dict[str, str]:
        """The API's sign-in variables: none while sign-in is off; all three settings or synth fails (a half-set
        login must not deploy as no login)."""
        values = {"auth_issuer": self.auth_issuer, "auth_jwks_url": self.auth_jwks_url,
                  "auth_client_id": self.auth_client_id}
        if not any(values.values()):
            return {}
        missing = [key for key, value in values.items() if not value]
        if missing:
            raise ValueError(f"[{self.name}] sign-in is half set: also set {', '.join(missing)} in infra/config.py")
        return {
            "DT_AUTH_MODE": "jwt",
            "DT_AUTH_ISSUER": self.auth_issuer,
            "DT_AUTH_JWKS_URL": self.auth_jwks_url,
            "DT_AUTH_AUDIENCE": self.auth_client_id,
        }

    @property
    def ssm_google_server_key(self) -> str:
        return f"/dolphin-tracker/{self.name}/google-maps-server-key"

    @property
    def cms_log_env(self) -> dict[str, str]:
        return {"DT_CMS_LOG_WRITE": "true"} if self.cms_log_write else {}

    @property
    def ssm_mongo_uri(self) -> str:
        return f"/dolphin-tracker/{self.name}/mongodb-uri"


ENVIRONMENTS: dict[str, EnvConfig] = {
    "dev": EnvConfig(
        name="dev",
        retain_data=False,
        cors_origins=["http://localhost:5173"],
        domain_name="tracker.dolphin-one.com",  # DNS is at GoDaddy: a CNAME to the CloudFront domain below
        certificate_arn="arn:aws:acm:us-east-1:519747127986:certificate/ac51e029-8352-408c-979b-ece470505075",
        cloudfront_domain="d2nm60ijusfh0v.cloudfront.net",  # the live site (DolphinTracker-Dev-Web)
        log_retention_days=14,
        api_warm_instances=1,
        # Sign-in through the shared Dolphin Nexus login. Remove these three lines to deploy without a login.
        auth_issuer="https://cognito-idp.us-east-1.amazonaws.com/us-east-1_U2DnRTmXT",
        auth_jwks_url="https://cognito-idp.us-east-1.amazonaws.com/us-east-1_U2DnRTmXT/.well-known/jwks.json",
        auth_client_id="1cpblkn568vqoogddkfl64br7g",  # the pool's "dolphin-tracker" app client
    ),
    "prod": EnvConfig(
        name="prod",
        retain_data=True,
        cors_origins=[],
        log_retention_days=90,
    ),
}


CONTEXT_OVERRIDES = ("google_browser_key", "google_map_id", "cloudfront_domain")


def load(env_name: str, context: dict[str, str] | None = None) -> EnvConfig:
    """The named environment, with any `-c key=value` overrides from CONTEXT_OVERRIDES applied."""
    try:
        cfg = ENVIRONMENTS[env_name]
    except KeyError as exc:
        raise SystemExit(f"Unknown env '{env_name}'. Known: {', '.join(ENVIRONMENTS)}") from exc
    overrides = {key: value for key, value in (context or {}).items() if key in CONTEXT_OVERRIDES and value}
    return replace(cfg, **overrides) if overrides else cfg
