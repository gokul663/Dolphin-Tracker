"""Pick lists (ROUTE-PLANNER §2, §5). Installers and managers grow when a new name is typed; categories are a
tree that starts from the offline portal's defaults."""
from __future__ import annotations

import re
from collections.abc import Iterator

from dolphin_tracker.domain.base import ApiModel
from dolphin_tracker.domain.errors import ValidationFailed
from dolphin_tracker.domain.lists import (
    NEW_INSTALLATION,
    Category,
    NameEntry,
    NameListKind,
    best_spellings,
    check_categories,
    clean_name,
    default_categories,
    find_subcategory,
    name_key,
)
from dolphin_tracker.domain.models import Page, Stop
from dolphin_tracker.domain.route_plans import PlanStatus
from dolphin_tracker.domain.statuses import INSTALLED_STATUSES, PENDING_STATUSES, store_assignment
from dolphin_tracker.repositories.lists import ListRepository
from dolphin_tracker.repositories.projects import ProjectRepository
from dolphin_tracker.repositories.route_plans import RoutePlanRepository
from dolphin_tracker.repositories.stores import StoreRepository


class ListService:
    def __init__(self, lists: ListRepository) -> None:
        self._lists = lists

    def names(self, kind: NameListKind, *, limit: int = 200, cursor: str | None = None) -> Page[NameEntry]:
        return self._lists.list_names(kind, limit=limit, cursor=cursor)

    def add_name(self, kind: NameListKind, value: str) -> NameEntry:
        name = clean_name(value)
        if not name:
            raise ValidationFailed("A name is required")
        return self._lists.add_name(kind, name)

    def save_installer(
        self, name: str, *, phone: str = "", phone2: str = "", email: str = "", email2: str = "",
        shipping_address: str = "", allow_no_phone: bool = False, must_be_new: bool = False, new_name: str = "",
    ) -> NameEntry:
        """An installer with how to reach them (the Installers page). A name and a phone number are needed; one
        without a phone is saved only when asked to (`allow_no_phone`) and shows as flagged until it has one.
        `new_name` renames the installer `name`: the entry keeps its id and moves to the new name (the records that
        name them are brought along by `InstallerWorkService.rename_records`)."""
        old = clean_name(name)
        value = clean_name(new_name) or old
        phone, phone2, email, email2 = clean_name(phone), clean_name(phone2), email.strip(), email2.strip()
        fields: dict[str, str] = {}
        if not value:
            fields["name"] = "A name is required"
        if not phone and not allow_no_phone:
            fields["phone"] = "A phone number is required (or add the installer without one)"
        for key, number in (("phone", phone), ("phone2", phone2)):
            if number and not 7 <= len(re.sub(r"\D", "", number)) <= 15:
                fields[key] = "Enter a phone number with 7 to 15 digits"
        for key, address in (("email", email), ("email2", email2)):
            if address and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", address):
                fields[key] = "Enter an email address like name@example.com"
        moved = name_key(value) != name_key(old)
        if moved and "name" not in fields and self._lists.get_entry(NameListKind.INSTALLERS, value) is not None:
            fields["name"] = "Already in the list"
        if fields:
            message = f"{value} is already an installer" if fields.get("name") == "Already in the list" else None
            raise ValidationFailed(message or next(iter(fields.values())), fields=fields)
        before = self._lists.get_entry(NameListKind.INSTALLERS, old) if value != old else None
        entry = NameEntry(
            id=before.id if before else "", created_at=before.created_at if before else "", value=value, phone=phone,
            phone2=phone2, email=email, email2=email2, shipping_address=" ".join(shipping_address.split()),
        )
        saved = self._lists.save_entry(NameListKind.INSTALLERS, entry, must_be_new=must_be_new)
        if saved is None:
            raise ValidationFailed(f"{value} is already an installer", fields={"name": "Already in the list"})
        if moved:
            self._lists.delete_name(NameListKind.INSTALLERS, old)
        return saved

    def remember(self, kind: NameListKind, value: str) -> None:
        """Add a typed name if it is new; blank is ignored (used by the visit and route-plan writes)."""
        if clean_name(value):
            self.add_name(kind, value)

    def delete_name(self, kind: NameListKind, value: str) -> None:
        self._lists.delete_name(kind, value)

    def categories(self) -> list[Category]:
        stored = self._lists.get_categories()
        if stored is None:
            return default_categories()
        # A tree saved before "New Installation" existed still offers it (an install visit needs a category).
        if not any(name_key(category.name) == name_key(NEW_INSTALLATION[0]) for category in stored):
            stored = [Category(name=NEW_INSTALLATION[0], subcategories=list(NEW_INSTALLATION[1])), *stored]
        return stored

    def replace_categories(self, categories: list[Category]) -> list[Category]:
        cleaned = [category.model_copy(update={"name": clean_name(category.name)}) for category in categories]
        errors = check_categories(cleaned)
        if errors:
            raise ValidationFailed(errors[0], errors=errors)
        self._lists.put_categories(cleaned)
        return cleaned

    def resolve_category(self, category: str, subcategory: str) -> tuple[str, str]:
        """The canonical spelling of a submitted pair; 422 if the pair is not in the tree."""
        found = find_subcategory(self.categories(), category, subcategory)
        if found is None:
            raise ValidationFailed(
                f'"{subcategory}" is not a subcategory of "{category}"', fields={"subcategory": "Not in the list"}
            )
        return found


class InstallerWork(ApiModel):
    """What one name has across every project: the stores it is the technician of and their screens."""

    name: str
    stores: int = 0
    screens_done: int = 0  # on the wall: Completed, Offline, Needs More Work
    screens_upcoming: int = 0
    # Stores that carry this installer's name in another case or spacing than the Installers list ("carlos").
    to_sync: int = 0


class InstallerWorkReport(ApiModel):
    installers: list[InstallerWork]  # everyone on the Installers list, alphabetical
    unlisted: list[InstallerWork]  # names on stores that match no installer, most stores first


class InstallerSyncResult(ApiModel):
    stores_updated: int


class InstallerSaved(NameEntry):
    """A saved installer, and what a rename carried along."""

    stores_renamed: int = 0
    plans_renamed: int = 0


class InstallerWorkService:
    """The Installers list against the stores of every project: who did how much, which names match nobody, and
    bringing the matching ones to the list's spelling."""

    def __init__(
        self, lists: ListRepository, projects: ProjectRepository, stores: StoreRepository,
        plans: RoutePlanRepository | None = None,
    ) -> None:
        self._lists, self._projects, self._stores, self._plans = lists, projects, stores, plans

    def rename_records(self, old: str, new: str) -> tuple[int, int]:
        """After an installer is renamed: the stores that name them as technician (in any case or spacing) and the
        active route plans they are on take the new name. Returns (stores, plans) changed. Closed plans and logged
        visits are history and keep the name they were written with."""
        key = name_key(old)
        stores = 0
        for project_id, stop in self._stops():
            if name_key(stop.installer_name) == key and stop.installer_name != new:
                self._stores.update_fields(project_id, stop.uid, {"installer_name": new})
                stores += 1
        return stores, self._rename_in_plans(key, new)

    def _rename_in_plans(self, key: str, new: str) -> int:
        if self._plans is None:
            return 0
        changed = 0
        cursor = None
        while True:
            page = self._plans.list(PlanStatus.ACTIVE, limit=100, cursor=cursor)
            for plan in page.items:
                same = lambda name: name_key(name) == key  # noqa: E731
                stops = [stop for stop in self._plans.list_stops(plan.id) if same(stop.installer)]
                if not stops and not any(same(installer.name) for installer in plan.installers):
                    continue
                if any(name_key(i.name) == name_key(new) and not same(i.name) for i in plan.installers):
                    continue  # the new name is already another installer of this plan: leave the plan alone
                self._plans.update(plan.id, {
                    "installers": [
                        {**installer.model_dump(), "name": new if same(installer.name) else installer.name}
                        for installer in plan.installers
                    ],
                    "days": [
                        {**day.model_dump(),
                         "starts": {(new if same(name) else name): start.model_dump()
                                    for name, start in day.starts.items()}}
                        for day in plan.days
                    ],
                    "locked_days": [
                        {"installer": new if same(lock.installer) else lock.installer, "day": lock.day}
                        for lock in plan.locked_days
                    ],
                })
                self._plans.update_assignments(plan.id, [(stop.key, {"installer": new}) for stop in stops])
                changed += 1
            cursor = page.next_cursor
            if not cursor:
                return changed

    def _listed(self) -> dict[str, str]:
        names: dict[str, str] = {}
        cursor = None
        while True:
            page = self._lists.list_names(NameListKind.INSTALLERS, limit=500, cursor=cursor)
            names.update({name_key(entry.value): entry.value for entry in page.items})
            cursor = page.next_cursor
            if not cursor:
                return names

    def _stops(self) -> Iterator[tuple[str, Stop]]:
        cursor = None
        while True:
            page = self._projects.list(limit=50, cursor=cursor)
            for project in page.items:
                for stop in self._stores.list_all(project.id):
                    yield project.id, stop
            cursor = page.next_cursor
            if not cursor:
                return

    def report(self) -> InstallerWorkReport:
        listed = self._listed()
        work = {key: InstallerWork(name=name) for key, name in listed.items()}
        spellings: dict[str, dict[str, int]] = {}
        for _project_id, stop in self._stops():
            name, _type = store_assignment(clean_name(stop.installer_name), stop.install_type or "")
            if not name:
                continue
            key = name_key(name)
            entry = work.setdefault(key, InstallerWork(name=name))
            entry.stores += 1
            entry.screens_done += sum(1 for screen in stop.screens if screen.status in INSTALLED_STATUSES)
            entry.screens_upcoming += sum(1 for screen in stop.screens if screen.status in PENDING_STATUSES)
            if key in listed:
                entry.to_sync += stop.installer_name != listed[key]
            else:
                counts = spellings.setdefault(key, {})
                counts[name] = counts.get(name, 0) + 1
        for key, counts in spellings.items():
            work[key].name = best_spellings(counts)[key]
        installers = sorted((work[key] for key in listed), key=lambda item: item.name.lower())
        unlisted = sorted((item for key, item in work.items() if key not in listed),
                          key=lambda item: (-item.stores, item.name.lower()))
        return InstallerWorkReport(installers=installers, unlisted=unlisted)

    def sync_names(self) -> InstallerSyncResult:
        """Stores whose technician matches an installer in another case or spacing take the list's spelling. A name
        that matches nobody is left as it is."""
        listed = self._listed()
        updated = 0
        for project_id, stop in self._stops():
            wanted = listed.get(name_key(stop.installer_name))
            if wanted and wanted != stop.installer_name:
                self._stores.update_fields(project_id, stop.uid, {"installer_name": wanted})
                updated += 1
        return InstallerSyncResult(stores_updated=updated)
