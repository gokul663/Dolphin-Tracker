"""A technician's own view: the days of every active plan they are on, and their own contact details. Nothing of
anyone else's (other installers' days and home addresses are left out of what is returned)."""
from __future__ import annotations

from pydantic import Field

from dolphin_tracker.domain.auth import Principal
from dolphin_tracker.domain.base import ApiModel
from dolphin_tracker.domain.errors import NotFoundError
from dolphin_tracker.domain.lists import NameEntry, NameListKind, clean_name, name_key
from dolphin_tracker.domain.models import ProjectType
from dolphin_tracker.domain.route_plans import PlanStatus, PlanStopState, RoutePlanBundle
from dolphin_tracker.domain.statuses import StatusBucket, store_assignment, store_bucket_of
from dolphin_tracker.repositories.projects import ProjectRepository
from dolphin_tracker.repositories.route_plans import RoutePlanRepository
from dolphin_tracker.repositories.stores import StoreRepository
from dolphin_tracker.services.lists import ListService
from dolphin_tracker.services.route_plans import RoutePlanService


class FixedStores(ApiModel):
    """Stores this technician is the technician of that are Completed now, across every project, by the kind of
    project: screens put in for the first time, or offline screens brought back."""

    new_installation: int = 0
    offline: int = 0
    mixed: int = 0  # in a project that holds both kinds, where a store does not say which it was


class MyRoute(ApiModel):
    # Their entry on the Installers page; None when the sign-in is not linked to one yet.
    installer: NameEntry | None = None
    # Each active plan they are on, cut down to their own days and stores.
    plans: list[RoutePlanBundle] = Field(default_factory=list)
    serviced_before: int = 0  # stores they finished in plans that are closed now
    fixed: FixedStores = Field(default_factory=FixedStores)


class MyProfileUpdate(ApiModel):
    """What a technician may change about themselves; their name, main phone and email are an Admin's to change."""

    phone2: str = Field(default="", max_length=50)
    shipping_address: str = Field(default="", max_length=500)


class TechnicianService:
    def __init__(
        self, lists: ListService, plans: RoutePlanService, plan_repo: RoutePlanRepository,
        projects: ProjectRepository, stores: StoreRepository,
    ) -> None:
        self._lists = lists
        self._plans = plans
        self._plan_repo = plan_repo
        self._projects = projects
        self._stores = stores

    def fixed(self, name: str) -> FixedStores:
        """Their completed stores in every project (the store's Technician is them), by project type."""
        key = name_key(name)
        field = {ProjectType.NEW_INSTALLATION: "new_installation", ProjectType.OFFLINE: "offline"}
        counts = FixedStores()
        cursor = None
        while True:
            page = self._projects.list(limit=50, cursor=cursor)
            for project in page.items:
                kind = field.get(project.project_type, "mixed")
                for item in self._stores.list_projected(project.id, ("installer_name", "install_type", "status")):
                    technician, _ = store_assignment(clean_name(item.get("installer_name") or ""),
                                                     item.get("install_type") or "")
                    try:
                        done = store_bucket_of(item.get("status") or "Upcoming") == StatusBucket.COMPLETED
                    except ValueError:  # a status from before the current ones: not counted
                        done = False
                    if done and technician and name_key(technician) == key:
                        setattr(counts, kind, getattr(counts, kind) + 1)
            cursor = page.next_cursor
            if not cursor:
                return counts

    def installer_for(self, who: Principal) -> NameEntry | None:
        """The installer this sign-in is: the one whose email (or additional email) on the Installers page is the
        sign-in's. Without a login, the one named in X-Dev-Installer."""
        entries = self._lists.names(NameListKind.INSTALLERS, limit=500).items
        link = who.installer_id.strip()
        if link:
            for entry in entries:
                if link in (entry.id, entry.value) or name_key(link) == name_key(entry.value):
                    return entry
            return None  # linked to someone who is not on the list: never fall through to another person
        email = who.email.strip().lower()
        if not email:
            return None
        return next((entry for entry in entries if email in (entry.email.lower(), entry.email2.lower())), None)

    @staticmethod
    def _own(bundle: RoutePlanBundle, name: str) -> RoutePlanBundle:
        key = name_key(name)
        mine = [stop for stop in bundle.stops if name_key(stop.installer) == key]
        keys = {stop.key for stop in mine}
        plan = bundle.plan.model_copy(deep=True)
        plan.installers = [person for person in plan.installers if name_key(person.name) == key]
        plan.locked_days = [lock for lock in plan.locked_days if name_key(lock.installer) == key]
        for day in plan.days:
            day.starts = {who: start for who, start in day.starts.items() if name_key(who) == key}
        plan.store_count = len(mine)
        return RoutePlanBundle(
            plan=plan,
            stops=mine,
            project_names={pid: label for pid, label in bundle.project_names.items()
                           if pid in {stop.project_id for stop in mine}},
            next_starts={who: start for who, start in bundle.next_starts.items() if name_key(who) == key},
            store_status={stop_key: status for stop_key, status in bundle.store_status.items() if stop_key in keys},
        )

    def _on_plan(self, status: PlanStatus, key: str):
        cursor = None
        while True:
            page = self._plans.list(status, limit=50, cursor=cursor)
            yield from (plan for plan in page.items if any(name_key(p.name) == key for p in plan.installers))
            cursor = page.next_cursor
            if not cursor:
                return

    def route(self, who: Principal) -> MyRoute:
        installer = self.installer_for(who)
        if installer is None:
            return MyRoute()
        key = name_key(installer.value)
        active = self._on_plan(PlanStatus.ACTIVE, key)
        plans = [self._own(self._plans.bundle(plan.id), installer.value) for plan in active]
        before = sum(
            1
            for plan in self._on_plan(PlanStatus.CLOSED, key)
            for stop in self._plan_repo.list_stops(plan.id)
            if name_key(stop.installer) == key and stop.state_value == PlanStopState.VISITED
        )
        return MyRoute(installer=installer, plans=[bundle for bundle in plans if bundle.stops], serviced_before=before,
                       fixed=self.fixed(installer.value))

    def update_profile(self, who: Principal, body: MyProfileUpdate) -> NameEntry:
        installer = self.installer_for(who)
        if installer is None:
            raise NotFoundError("Your sign-in is not linked to an installer yet")
        return self._lists.save_installer(
            installer.value, phone=installer.phone, phone2=body.phone2, email=installer.email, email2=installer.email2,
            shipping_address=body.shipping_address.strip(), allow_no_phone=True,
        )
