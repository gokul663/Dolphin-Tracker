"""Who may do what. Roles come from the sign-in service (Dolphin Nexus) in the token; this app only maps a role to
permissions and checks them. Endpoints ask for a permission, never a role, so a role's rights change in one table.
Pure."""
from __future__ import annotations

from enum import StrEnum

from pydantic import Field

from dolphin_tracker.domain.base import ApiModel


class Role(StrEnum):
    SUPER_ADMIN = "super_admin"
    ADMIN = "admin"
    OPERATOR = "operator"
    VIEWER = "viewer"
    TECHNICIAN = "technician"


class Permission(StrEnum):
    PROJECTS_VIEW = "projects.view"        # projects, their stores, history, lists
    PROJECTS_EDIT = "projects.edit"        # projects, stores, sheets, settings, device sync
    INSTALLERS_MANAGE = "installers.manage"  # the Installers page and the other name lists
    ROUTES_VIEW = "routes.view"            # every route plan
    ROUTES_MANAGE = "routes.manage"        # create, edit, add stores, next day, close, take a store out for good
    ROUTES_ARRANGE = "routes.arrange"      # inside a plan: another day or installer, set aside, Done / Incomplete
    VISITS_LOG = "visits.log"              # log a visit; edit a store's screens, WiFi and comment while on a route
    ROUTES_OWN = "routes.own"              # a technician: their own days and their own contact details


_VIEW = {Permission.PROJECTS_VIEW, Permission.ROUTES_VIEW}
_EVERYTHING = set(Permission) - {Permission.ROUTES_OWN}

ROLE_PERMISSIONS: dict[Role, frozenset[Permission]] = {
    # The same today. What sets a Super Admin apart (signing in as someone else) happens in the sign-in service.
    Role.SUPER_ADMIN: frozenset(_EVERYTHING),
    Role.ADMIN: frozenset(_EVERYTHING),
    Role.OPERATOR: frozenset(_VIEW | {Permission.ROUTES_ARRANGE, Permission.VISITS_LOG}),
    Role.VIEWER: frozenset(_VIEW),
    Role.TECHNICIAN: frozenset({Permission.ROUTES_OWN}),
}


def parse_role(value: object) -> Role | None:
    """A role as the token may spell it: "Super Admin", "super-admin", "SUPER_ADMIN"."""
    if not isinstance(value, str):
        return None
    key = "_".join(value.replace("-", " ").replace("_", " ").lower().split())
    return next((role for role in Role if role.value == key), None)


# Most privileged first: someone in several of this app's groups gets the highest.
ROLE_RANK = (Role.SUPER_ADMIN, Role.ADMIN, Role.OPERATOR, Role.VIEWER, Role.TECHNICIAN)


def role_from_groups(groups: object, app: str) -> Role | None:
    """The role in a list of the sign-in service's groups ("tracker:admin", "venue-vision:viewer"): the ones
    prefixed with this app, the most privileged when there are several. None when there is none for this app."""
    if not isinstance(groups, list | tuple):
        return None
    prefix = f"{app}:"
    held = {parse_role(group[len(prefix):]) for group in groups if isinstance(group, str) and group.startswith(prefix)}
    return next((role for role in ROLE_RANK if role in held), None)


class Principal(ApiModel):
    """The signed-in person, as the token says."""

    id: str
    name: str = ""
    email: str = ""
    role: Role
    # Without a login only (X-Dev-Installer): which installer to be. A signed-in technician is matched to their
    # entry on the Installers page by email.
    installer_id: str = ""
    # Set when a Super Admin is signed in as this person: who is really at the keyboard.
    acting_by: str = ""
    permissions: list[Permission] = Field(default_factory=list)

    def can(self, permission: Permission) -> bool:
        return permission in ROLE_PERMISSIONS[self.role]

    @property
    def label(self) -> str:
        """The name written into "updated by" fields."""
        name = self.name or self.email or self.id
        return f"{name} (as signed in by {self.acting_by})" if self.acting_by else name


def principal(**fields) -> Principal:
    made = Principal(**fields)
    made.permissions = sorted(ROLE_PERMISSIONS[made.role])
    return made


# What someone who logs visits (but cannot edit projects) may change on a store, and only while it is on a route.
SERVICE_STORE_FIELDS = frozenset({
    "store_ssid", "store_ssid_password", "screens_used", "mounts_used",
    "owner_name", "owner_phone", "owner_email", "onsite_contact_name", "onsite_contact_phone",
})
SERVICE_PROGRESS_FIELDS = frozenset({"comment", "updated_by"})


def store_edit_problem(who: Principal, on_route: bool, fields: set[str], allowed: frozenset[str] | None) -> str:
    """Why this person may not make this store edit ("" when they may). `allowed` None = any field of the call."""
    if who.can(Permission.PROJECTS_EDIT):
        return ""
    if not who.can(Permission.VISITS_LOG):
        return "You do not have permission to edit stores"
    if not on_route:
        return "You can edit a store only while it is on an active route"
    extra = sorted(fields - allowed) if allowed is not None else []
    return f"You do not have permission to change: {', '.join(extra)}" if extra else ""
