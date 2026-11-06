"""Servicing visits (ROUTE-PLANNER §3, §5): one per stick, logged by a Dolphin manager. A visit never changes
status. Store, address, PA/FA and contacts are snapshotted from the store at submission."""
from __future__ import annotations

from dolphin_tracker.domain.errors import NotFoundError, ValidationFailed
from dolphin_tracker.domain.lists import REPLACED_WITH_SUBCATEGORIES, NameListKind
from dolphin_tracker.domain.models import Page, Project, Stop
from dolphin_tracker.domain.visits import Visit, VisitInput
from dolphin_tracker.repositories.projects import ProjectRepository
from dolphin_tracker.repositories.stores import StoreRepository
from dolphin_tracker.repositories.visits import VisitRepository
from dolphin_tracker.services.lists import ListService
from dolphin_tracker.services.route_plans import RoutePlanService


class VisitService:
    def __init__(
        self,
        visits: VisitRepository,
        stores: StoreRepository,
        projects: ProjectRepository,
        lists: ListService,
        plans: RoutePlanService | None = None,
    ) -> None:
        self._visits = visits
        self._stores = stores
        self._projects = projects
        self._lists = lists
        self._plans = plans

    def _load(self, project_id: str, stop_uid: str) -> tuple[Project, Stop]:
        project = self._projects.get(project_id)
        if project is None:
            raise NotFoundError(f"Project {project_id} not found")
        stop = self._stores.get(project_id, stop_uid)
        if stop is None:
            raise NotFoundError(f"Stop {stop_uid} not found")
        return project, stop

    def list(self, project_id: str, stop_uid: str, *, limit: int = 50, cursor: str | None = None) -> Page[Visit]:
        self._load(project_id, stop_uid)
        return self._visits.list_for_store(project_id, stop_uid, limit=limit, cursor=cursor)

    def build(self, project: Project, stop: Stop, body: VisitInput) -> Visit:
        """Validate the form against the store and the pick lists and snapshot the store's details."""
        if not any(screen.id == body.screen_id for screen in stop.screens):
            raise ValidationFailed("That stick is not on this store", fields={"screen_id": "Unknown stick"})
        category, subcategory = self._lists.resolve_category(body.category, body.subcategory)
        if subcategory in REPLACED_WITH_SUBCATEGORIES and not body.replaced_with:
            raise ValidationFailed(
                f'"{subcategory}" needs the new number', fields={"replaced_with": "Required for this subcategory"}
            )
        plan_id = body.route_plan_id or stop.route_plan_id
        plan_day = self._plans.stop_day(plan_id, project.id, stop.uid) if plan_id and self._plans else None
        return Visit(
            **body.model_dump(exclude={"category", "subcategory", "route_plan_id"}),
            category=category,
            subcategory=subcategory,
            route_plan_id=plan_id if plan_day is not None else "",  # only when the store is in that plan
            plan_day=plan_day,
            project_id=project.id,
            stop_uid=stop.uid,
            store_name=stop.store_name,
            addr=", ".join(part for part in (stop.addr, stop.city, stop.state, stop.zip) if part),
            pa=stop.pa or project.pa,
            fa=project.field_agent,
            owner_name=stop.owner_name,
            owner_phone=stop.owner_phone,
            owner_email=stop.owner_email,
            store_contact_name=stop.onsite_contact_name,
            store_contact_phone=stop.onsite_contact_phone,
        )

    def create(self, project_id: str, stop_uid: str, body: VisitInput) -> Visit:
        project, stop = self._load(project_id, stop_uid)
        visit = self._visits.add(self.build(project, stop, body))
        if visit.route_plan_id and self._plans:
            self._plans.record_visit(visit.route_plan_id, project_id, stop_uid, visit.screen_id)
        self._lists.remember(NameListKind.INSTALLERS, visit.installer)
        self._lists.remember(NameListKind.MANAGERS, visit.dolphin_manager)
        return visit
