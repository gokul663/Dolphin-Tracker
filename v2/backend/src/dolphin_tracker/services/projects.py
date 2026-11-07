"""Project use cases: list/get/update/delete and creation (which hands the first routing build to the worker)."""
from __future__ import annotations

import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from dolphin_tracker.domain.errors import NotFoundError, ValidationFailed
from dolphin_tracker.domain.import_mapping import clean_mapping, split_duplicates
from dolphin_tracker.domain.kpi import KPI_ATTRIBUTES, kpi_summary
from dolphin_tracker.domain.models import (
    FieldDef,
    Page,
    Project,
    ProjectCreate,
    ProjectSummary,
    Stop,
    attention_of,
)
from dolphin_tracker.domain.schema import (
    coerce_fields,
    default_field_schema,
    validate_schema,
    validate_stop_inputs,
    with_sheet_fields,
)
from dolphin_tracker.domain.validation import stop_details
from dolphin_tracker.repositories.projects import ProjectRepository
from dolphin_tracker.repositories.stores import StoreRepository
from dolphin_tracker.services.routing import RoutingService


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

    def summary(self, project_id: str) -> ProjectSummary:
        """One project with its KPIs (the project header, STORE-MODEL §5)."""
        assert self._stores is not None
        project = self.get(project_id)
        rows = self._stores.list_projected(project_id, KPI_ATTRIBUTES)
        return ProjectSummary(**project.model_dump(), kpi=kpi_summary(rows))

    def get(self, project_id: str) -> Project:
        project = self._projects.get(project_id)
        if project is None:
            raise NotFoundError(f"Project {project_id} not found")
        return project

    def create(self, payload: ProjectCreate) -> tuple[Project, list[dict[str, Any]]]:
        """Validate and write META + stops. Stores start unrouted: routes are built in route plans.

        Returns (project, skipped duplicates). Every invalid stop is reported at once
        (422); a stop repeating an earlier one (IBC#, then address) is skipped and reported."""
        errors: list[Any] = []
        name, pa = payload.name.strip(), payload.pa.strip()
        if not name:
            errors.append("Project name is required")
        if not pa:  # several PAs: each stop carries its own, and the project lists them
            pa = ", ".join(sorted({stop.pa.strip() for stop in payload.stops if stop.pa.strip()}))
        if not pa:
            errors.append("PA is required (or a PA column in the sheet when the project has several)")
        schema = payload.field_schema if payload.field_schema is not None else default_field_schema()
        errors.extend(validate_schema(schema))
        schema = with_sheet_fields(schema, payload.stops)  # the sheet's "Other imported data" columns

        stop_errors = validate_stop_inputs(schema, payload.stops)
        if errors or stop_errors:
            bad_rows = f"; {len(stop_errors)} stop(s) need fixing" if stop_errors else ""
            raise ValidationFailed(f"Project could not be created{bad_rows}", errors=errors, stops=stop_errors)

        assert self._stores is not None
        keep, skipped = split_duplicates([], payload.stops)
        kept = [payload.stops[index] for index in keep]
        project_id = uuid.uuid4().hex
        project = Project(
            id=project_id,
            name=name,
            pa=pa,
            project_type=payload.project_type,
            field_agent=payload.field_agent.strip(),
            partner_account=payload.partner_account.strip(),
            pa_percentage=payload.pa_percentage,
            dolphin_percentage=payload.dolphin_percentage,
            store_percentage=payload.store_percentage,
            fa_percentage=payload.fa_percentage,
            field_schema=schema,
            import_mappings=clean_mapping(payload.import_mapping),
            stop_count=len(kept),
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
                **stop_details(stop),
                screens=stop.build_screens(),
                installer_name=stop.installer_name.strip(),
                needs_attention=attention_of(stop),
            )
            for index, stop in enumerate(kept)
        ]
        # Stops first: if the META write fails there is no visible project, only orphan stop items.
        self._stores.put_many(project_id, stops)
        self._projects.put(project)
        return project, skipped

    UPDATABLE = frozenset(
        {
            "name", "pa", "project_type", "field_agent", "partner_account", "pa_percentage", "dolphin_percentage",
            "store_percentage", "fa_percentage", "field_schema",
        }
    )
    REQUIRED_TEXT = ("name",)
    NOT_NULL = ("name", "pa", "project_type", "field_agent", "partner_account", "field_schema")

    def update(self, project_id: str, changes: dict[str, Any], *, expected_version: int | None = None) -> Project:
        """Metadata only (bounds are checked by the request model). A new `stops_per_day` applies from the next
        routing build; a new `field_schema` does not rewrite existing stop values."""
        extra = set(changes) - self.UPDATABLE
        if extra:
            raise ValueError(f"Not updatable here: {sorted(extra)}")
        errors = [f"{key} cannot be null" for key in self.NOT_NULL if key in changes and changes[key] is None]
        update = {key: value.strip() if isinstance(value, str) else value for key, value in changes.items()}
        errors += [f"{key} cannot be blank" for key in self.REQUIRED_TEXT if update.get(key, "x") == ""]
        current = self.get(project_id)
        if update.get("field_schema") is not None:
            existing = [field.key for field in current.field_schema]
            errors += validate_schema((FieldDef.model_validate(field) for field in update["field_schema"]), existing)
        if errors:
            raise ValidationFailed("; ".join(errors), errors=errors)
        if not update:
            raise ValidationFailed("No fields to update", errors=[])
        return self._projects.update(project_id, update, expected_version=expected_version)

    def delete(self, project_id: str, *, confirm: str) -> None:
        """Two-step safeguard from v1: the caller must echo the exact project name."""
        project = self.get(project_id)
        if confirm.strip() != project.name.strip():
            raise ValueError("Confirmation does not match. Type the project name exactly to delete it.")
        if self._stores is not None:
            self._stores.delete_all(project_id)
        self._projects.delete(project_id)
