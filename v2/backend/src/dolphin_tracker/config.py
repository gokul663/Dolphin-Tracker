"""Runtime settings. Every variable is prefixed DT_ (e.g. DT_TABLE_NAME)."""
from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DT_", env_file=".env", extra="ignore")

    app_env: str = "local"
    aws_region: str = "us-east-1"
    table_name: str = "dolphin-tracker-local"
    dynamodb_endpoint_url: str | None = None  # http://localhost:8000 for DynamoDB Local
    files_bucket: str = ""
    worker_function_name: str = ""
    cors_origins: str = "http://localhost:5173"  # comma-separated
    google_server_key: str = ""  # direct value for local dev
    google_server_key_param: str = ""  # SSM SecureString name, used in Lambda when the direct value is empty
    google_browser_key: str = ""

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def is_local(self) -> bool:
        return self.app_env in {"local", "test"}


@lru_cache
def get_settings() -> Settings:
    return Settings()


@lru_cache
def resolve_google_server_key(settings: Settings | None = None) -> str:
    """Return the Google server key from settings, or fetch it once from SSM when only a parameter name is set."""
    settings = settings or get_settings()
    if settings.google_server_key:
        return settings.google_server_key
    if not settings.google_server_key_param:
        return ""
    import boto3  # local import keeps module import cheap for tests

    client = boto3.client("ssm", region_name=settings.aws_region)
    response = client.get_parameter(Name=settings.google_server_key_param, WithDecryption=True)
    return response["Parameter"]["Value"].strip()
