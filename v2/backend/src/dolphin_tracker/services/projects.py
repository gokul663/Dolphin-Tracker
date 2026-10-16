"""Project use cases: list/get/update/delete and creation (which hands the first routing build to the worker)."""
from __future__ import annotations

import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from dolphin_tracker.domain.errors import NotFoundError, ValidationFailed
from dolphin_tracker.domain.kpi import KPI_ATTRIBUTES, kpi_summary
from dolphin_tracker.domain.models import (
    FieldDef,
    Page,
    Project,
    ProjectCreate,
    ProjectSummary,
    RoutingStatus,
    Stop,
    StopStatus,
)
from dolphin_tracker.domain.schema import (
    coerce_fields,
    default_field_schema,
    validate_schema,
    validate_stop_inputs,
)
from dolphin_tracker.repositories.projects import ProjectRepository
from dolphin_tracker.repositories.stores import StoreRepository
from dolphin_tracker.services.routing import RoutingService


def clean_installers(names: list[str]) -> tuple[list[str], list[str]]:
    """Strip names; returns (installers, problems) where problems lists blanks and duplicates."""
    cleaned = [name.strip() for name in names]
    problems = []
    if any(not name for name in cleaned):
        problems.append("Installer names cannot be blank")
    duplicates = sorted({name for name in cleaned if name and cleaned.count(name) > 1})
    if duplicates:
        problems.append(f"Duplicate installer names: {', '.join(duplicates)}")
    return cleaned, problems


class ProjectService:
    def __init__(
        self,
        projects: ProjectRepository,
        stores: StoreRepository | None = None,
        routing: RoutingService | None = None,
    ) -> None:
        self._projects = projects
        self._stores = stores
        self._routing = routing

    KPI_WORKERS = 8

    def list(self, *, limit: int = 50, cursor: str | None = None) -> Page[ProjectSummary]:
        """A page of projects, each with KPIs from one projected Query, fanned out over a thread pool."""
        assert self._stores is not None
        page = self._projects.list(limit=limit, cursor=cursor)
        stores = self._stores

        def summarise(project: Project) -> ProjectSummary:
            rows = stores.list_projected(project.id, KPI_ATTRIBUTES)
            return ProjectSummary(**project.model_dump(), kpi=kpi_summary(rows))

        with ThreadPoolExecutor(max_workers=self.KPI_WORKERS) as pool:
            items = list(pool.map(summarise, page.items))
        return Page(items=items, next_cursor=page.next_cursor)

    def get(self, project_id: str) -> Project:
        project = self._projects.get(project_id)
        if project is None:
            raise NotFoundError(f"Project {project_id} not found")
        return project

    def create(self, payload: ProjectCreate) -> tuple[Project, str | None]:
        """Validate, write META + stops, and start the `create` routing job when there are stops.

        Returns (project, routing_job_id or None). Every invalid stop is reported at once (422).
        """
        errors: list[Any] = []
        name, pa = payload.name.strip(), payload.pa.strip()
        if not name:
            errors.append("Project name is required")
        if not pa:
            errors.append("PA is required")
        installers, installer_problems = clean_installers(payload.installers)
        errors.extend(installer_problems)
        schema = payload.field_schema if payload.field_schema is not None else default_field_schema()
        errors.extend(validate_schema(schema))

        stop_errors = validate_stop_inputs(schema, payload.stops)
        if errors or stop_errors:
            bad_rows = f"; {len(stop_errors)} stop(s) need fixing" if stop_errors else ""
            raise ValidationFailed(f"Project could not be created{bad_rows}", errors=errors, stops=stop_errors)

        assert self._stores is not None
        project_id = uuid.uuid4().hex
        job = RoutingService.new_job(project_id, "create") if payload.stops else None
        project = Project(
            id=project_id,
            name=name,
            pa=pa,
            project_type=payload.project_type,
            installers=installers,
            field_agent=payload.field_agent.strip(),
            partner_account=payload.partner_account.strip(),
            pa_percentage=payload.pa_percentage,
            dolphin_percentage=payload.dolphin_percentage,
            store_percentage=payload.store_percentage,
            fa_percentage=payload.fa_percentage,
            stops_per_day=payload.stops_per_day,
            field_schema=schema,
            routing_status=RoutingStatus.BUILDING if job else RoutingStatus.READY,
            routing_job_id=job.id if job else "",
            stop_count=len(payload.stops),
        )
        stops = [
            Stop(
                uid=uuid.uuid4().hex,
                display_id=f"S{index + 1}",
                store_name=stop.store_name.strip(),
                addr=stop.addr.strip(),
                city=stop.city.strip(),
                state=stop.state.strip(),
                zip=stop.zip.strip(),
                lat=stop.lat,
                lng=stop.lng,
                geocoded=stop.geocoded.strip(),
                installer="",
                day=1,
                seq=index,
                fields=coerce_fields(schema, stop.fields),
                status=stop.initial_status or StopStatus.INCOMPLETE,
            )
            for index, stop in enumerate(payload.stops)
        ]
        # Stops first: if the META write fails there is no visible project, only orphan stop items.
        self._stores.put_many(project_id, stops)
        self._projects.put(project)
        if job is None:
            return project, None
        assert self._routing is not None
        try:
            self._routing.record_and_launch(job)
        except RuntimeError:
            # The project and its stops are saved; launch() already marked routing failed. Return them so the
            # client can open the project and retry with recluster instead of losing the import.
            return self.get(project_id), job.id
        return project, job.id

    UPDATABLE = frozenset(
        {
            "name", "pa", "project_type", "field_agent", "partner_account", "pa_percentage", "dolphin_percentage",
            "store_percentage", "fa_percentage", "stops_per_day", "field_schema",
        }
    )
    REQUIRED_TEXT = ("name",)
    NOT_NULL = ("name", "pa", "project_type", "field_agent", "partner_account", "pa_percentage",
                "dolphin_percentage", "stops_per_day", "field_schema")

    def update(self, project_id: str, changes: dict[str, Any], *, expected_version: int | None = None) -> Project:
        """Metadata only (bounds are checked by the request model). A new `stops_per_day` applies from the next
        routing build; a new `field_schema` does not rewrite existing stop values."""
        extra = set(changes) - self.UPDATABLE
        if extra:
            raise ValueError(f"Not updatable here: {sorted(extra)}")
        errors = [f"{key} cannot be null" for key in self.NOT_NULL if key in changes and changes[key] is None]
        update = {key: value.strip() if isinstance(value, str) else value for key, value in changes.items()}
        errors += [f"{key} cannot be blank" for key in self.REQUIRED_TEXT if update.get(key, "x") == ""]
        if update.get("field_schema") is not None:
            errors += validate_schema(FieldDef.model_validate(field) for field in update["field_schema"])
        if errors:
            raise ValidationFailed("; ".join(errors), errors=errors)
        if not update:
            raise ValidationFailed("No fields to update", errors=[])
        self.get(project_id)
        return self._projects.update(project_id, update, expected_version=expected_version)

    def delete(self, project_id: str, *, confirm: str) -> None:
        """Two-step safeguard from v1: the caller must echo the exact project name."""
        project = self.get(project_id)
        if confirm.strip() != project.name.strip():
            raise ValueError("Confirmation does not match. Type the project name exactly to delete it.")
        if self._stores is not None:
            self._stores.delete_all(project_id)
        self._projects.delete(project_id)
