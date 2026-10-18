"""Per-environment settings for the CDK app. Keep this file free of secrets."""
from dataclasses import dataclass, field, replace


@dataclass(frozen=True)
class EnvConfig:
    name: str
    retain_data: bool
    cors_origins: list[str] = field(default_factory=list)
    domain_name: str | None = None          # e.g. "tracker.example.com"; None = CloudFront default domain
    certificate_arn: str | None = None      # ACM cert in us-east-1 for the domain above
    cloudfront_domain: str | None = None    # e.g. "d1234abcd.cloudfront.net", once the Web stack has deployed
    log_retention_days: int = 30
    # Public by design (Maps JS runs in the browser); restrict it by HTTP referrer in Google Cloud. Not a secret,
    # but it can also come from `-c google_browser_key=...` so it need not be committed.
    google_browser_key: str = ""
    google_map_id: str = ""  # Google Cloud Map ID (public); the user creates it

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

    @property
    def ssm_google_server_key(self) -> str:
        return f"/dolphin-tracker/{self.name}/google-maps-server-key"


ENVIRONMENTS: dict[str, EnvConfig] = {
    "dev": EnvConfig(
        name="dev",
        retain_data=False,
        cors_origins=["http://localhost:5173"],
        log_retention_days=14,
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
