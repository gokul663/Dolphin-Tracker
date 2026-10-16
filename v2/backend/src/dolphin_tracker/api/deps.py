"""Dependency wiring. Tests override these with `app.dependency_overrides`."""
from __future__ import annotations

from collections.abc import Callable
from functools import lru_cache
from typing import Annotated

import boto3
from botocore.config import Config
from fastapi import Depends

from dolphin_tracker.config import Settings, get_settings
from dolphin_tracker.repositories.dynamo import dynamodb_resource
from dolphin_tracker.repositories.projects import DynamoProjectRepository, ProjectRepository
from dolphin_tracker.repositories.stores import DynamoStoreRepository, StoreRepository
from dolphin_tracker.services.projects import ProjectService
from dolphin_tracker.services.stores import StoreService

SettingsDep = Annotated[Settings, Depends(get_settings)]


@lru_cache
def _table(table_name: str, region: str, endpoint: str | None):
    settings = Settings(table_name=table_name, aws_region=region, dynamodb_endpoint_url=endpoint)
    return dynamodb_resource(settings).Table(table_name)


def get_table(settings: SettingsDep):
    return _table(settings.table_name, settings.aws_region, settings.dynamodb_endpoint_url)


def get_project_repository(table: Annotated[object, Depends(get_table)]) -> ProjectRepository:
    return DynamoProjectRepository(table)


def get_store_repository(table: Annotated[object, Depends(get_table)]) -> StoreRepository:
    return DynamoStoreRepository(table)


def get_project_service(
    projects: Annotated[ProjectRepository, Depends(get_project_repository)],
    stores: Annotated[StoreRepository, Depends(get_store_repository)],
) -> ProjectService:
    return ProjectService(projects, stores)


def get_store_service(stores: Annotated[StoreRepository, Depends(get_store_repository)]) -> StoreService:
    return StoreService(stores)


def get_db_probe(settings: SettingsDep) -> Callable[[], bool]:
    """Fast, non-retrying table check for /health."""

    def probe() -> bool:
        try:
            client = boto3.client(
                "dynamodb",
                region_name=settings.aws_region,
                endpoint_url=settings.dynamodb_endpoint_url or None,
                config=Config(connect_timeout=1, read_timeout=2, retries={"max_attempts": 1}),
            )
            client.describe_table(TableName=settings.table_name)
            return True
        except Exception:
            return False

    return probe
