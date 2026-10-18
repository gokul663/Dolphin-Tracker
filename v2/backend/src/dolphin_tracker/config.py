"""Runtime settings. Every variable is prefixed DT_ (e.g. DT_TABLE_NAME)."""
from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DT_", env_file=".env", extra="ignore", populate_by_name=True)

    app_env: str = "local"
    # DT_AWS_REGION wins; otherwise the Lambda runtime's own AWS_REGION, so a deploy outside us-east-1 still points
    # every boto3 client at the right region.
    aws_region: str = Field(default="us-east-1", validation_alias=AliasChoices("DT_AWS_REGION", "AWS_REGION"))
    table_name: str = "dolphin-tracker-local"
    dynamodb_endpoint_url: str | None = None  # http://localhost:8000 for DynamoDB Local
    files_bucket: str = ""  # empty: files live in local_files_dir and the local upload/result routes are used
    local_files_dir: str = ".local-files"
    max_upload_bytes: int = 20 * 1024 * 1024
    worker_function_name: str = ""
    worker_mode: Literal["lambda", "inline"] = "lambda"  # inline: run jobs on a thread in the API process (local)
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


def resolve_google_server_key(settings: Settings | None = None) -> str:
    """Return the Google server key from settings, or fetch it once from SSM when only a parameter name is set."""
    settings = settings or get_settings()
    if settings.google_server_key:
        return settings.google_server_key
    if not settings.google_server_key_param:
        return ""
    return _ssm_secure_string(settings.google_server_key_param, settings.aws_region)


@lru_cache
def _ssm_secure_string(name: str, region: str) -> str:
    # Cached on hashable strings: Settings itself is a pydantic model and cannot be an lru_cache key.
    import boto3  # local import keeps module import cheap for tests

    client = boto3.client("ssm", region_name=region)
    response = client.get_parameter(Name=name, WithDecryption=True)
    return response["Parameter"]["Value"].strip()
