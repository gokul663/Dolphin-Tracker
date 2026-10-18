"""Dependency wiring. Tests override these with `app.dependency_overrides`."""
from __future__ import annotations

from collections.abc import Callable
from functools import lru_cache
from typing import Annotated

import boto3
from botocore.config import Config
from fastapi import Depends

from dolphin_tracker.config import Settings, get_settings, resolve_google_server_key
from dolphin_tracker.repositories.dynamo import dynamodb_resource
from dolphin_tracker.repositories.files import FileStore, make_file_store
from dolphin_tracker.repositories.jobs import DynamoJobRepository, JobRepository
from dolphin_tracker.repositories.projects import DynamoProjectRepository, ProjectRepository
from dolphin_tracker.repositories.stores import DynamoStoreRepository, StoreRepository
from dolphin_tracker.repositories.worker_invoker import WorkerInvoker, make_invoker
from dolphin_tracker.services.geocoding import GoogleGeocoder
from dolphin_tracker.services.imports import ImportService
from dolphin_tracker.services.jobs import JobService
from dolphin_tracker.services.places import PlacesService
from dolphin_tracker.services.projects import ProjectService
from dolphin_tracker.services.routing import RoutingService
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


def get_job_repository(table: Annotated[object, Depends(get_table)]) -> JobRepository:
    return DynamoJobRepository(table)


def get_file_store(settings: SettingsDep) -> FileStore:
    return make_file_store(settings)


@lru_cache
def _invoker(mode: str, function_name: str, region: str) -> WorkerInvoker:
    return make_invoker(Settings(worker_mode=mode, worker_function_name=function_name, aws_region=region))


def get_worker_invoker(settings: SettingsDep) -> WorkerInvoker:
    return _invoker(settings.worker_mode, settings.worker_function_name, settings.aws_region)


def get_job_service(
    jobs: Annotated[JobRepository, Depends(get_job_repository)],
    files: Annotated[FileStore, Depends(get_file_store)],
    invoker: Annotated[WorkerInvoker, Depends(get_worker_invoker)],
    projects: Annotated[ProjectRepository, Depends(get_project_repository)],
    settings: SettingsDep,
) -> JobService:
    def missing_google_key() -> bool:  # §9 #3: outside local, an import without a server key fails fast
        return not settings.is_local and not resolve_google_server_key(settings)

    return JobService(jobs, files, invoker, projects, missing_google_key=missing_google_key)


@lru_cache
def _geocoder(api_key: str) -> GoogleGeocoder:
    return GoogleGeocoder(api_key)  # one httpx.Client per warm process


def get_geocoder(settings: SettingsDep) -> GoogleGeocoder:
    return _geocoder(resolve_google_server_key(settings))


def get_import_service(
    jobs: Annotated[JobRepository, Depends(get_job_repository)],
    files: Annotated[FileStore, Depends(get_file_store)],
) -> ImportService:
    """For synchronous import operations (re-mapping); the geocoding run itself happens on the worker."""
    return ImportService(jobs, files)


def get_routing_service(
    projects: Annotated[ProjectRepository, Depends(get_project_repository)],
    stores: Annotated[StoreRepository, Depends(get_store_repository)],
    jobs: Annotated[JobRepository, Depends(get_job_repository)],
    invoker: Annotated[WorkerInvoker, Depends(get_worker_invoker)],
) -> RoutingService:
    return RoutingService(projects, stores, jobs, invoker)


def get_project_service(
    projects: Annotated[ProjectRepository, Depends(get_project_repository)],
    stores: Annotated[StoreRepository, Depends(get_store_repository)],
    routing: Annotated[RoutingService, Depends(get_routing_service)],
) -> ProjectService:
    return ProjectService(projects, stores, routing)


def get_store_service(
    stores: Annotated[StoreRepository, Depends(get_store_repository)],
    projects: Annotated[ProjectRepository, Depends(get_project_repository)],
    geocoder: Annotated[GoogleGeocoder, Depends(get_geocoder)],
) -> StoreService:
    return StoreService(stores, projects, geocoder)


def get_places_service(geocoder: Annotated[GoogleGeocoder, Depends(get_geocoder)]) -> PlacesService:
    return PlacesService(geocoder)


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
