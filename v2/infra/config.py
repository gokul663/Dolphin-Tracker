"""Per-environment settings for the CDK app. Keep this file free of secrets."""
from dataclasses import dataclass, field


@dataclass(frozen=True)
class EnvConfig:
    name: str
    retain_data: bool
    cors_origins: list[str] = field(default_factory=list)
    domain_name: str | None = None          # e.g. "tracker.example.com"; None = CloudFront default domain
    certificate_arn: str | None = None      # ACM cert in us-east-1 for the domain above
    log_retention_days: int = 30

    @property
    def prefix(self) -> str:
        return f"DolphinTracker-{self.name.capitalize()}"

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


def load(env_name: str) -> EnvConfig:
    try:
        return ENVIRONMENTS[env_name]
    except KeyError as exc:
        raise SystemExit(f"Unknown env '{env_name}'. Known: {', '.join(ENVIRONMENTS)}") from exc
