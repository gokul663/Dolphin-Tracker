"""Sign-in at the HTTP edge: who is calling (from the token), and whether they may call this endpoint.

Every route under /api is in POLICY: a route that is not is refused, so a new endpoint cannot ship unprotected
(tests/test_auth.py also fails for it)."""
from __future__ import annotations

from functools import lru_cache
from typing import Annotated, Any

import jwt
from fastapi import Depends, HTTPException, Request

from dolphin_tracker.config import Settings, get_settings
from dolphin_tracker.domain.auth import Permission, Principal, Role, parse_role, principal, role_from_groups

P = Permission
PUBLIC = "public"  # no sign-in at all
SIGNED_IN = "signed-in"  # any role

_STORE = "/api/projects/{project_id}/stores/{stop_uid}"
_PLAN = "/api/route-plans/{plan_id}"
_PLAN_STOP = _PLAN + "/stops/{project_id}/{stop_uid}"
_PROJECT = "/api/projects/{project_id}"

POLICY: dict[tuple[str, str], Permission | str] = {
    ("GET", "/api"): PUBLIC,
    ("GET", "/api/health"): PUBLIC,
    ("GET", "/api/me"): SIGNED_IN,
    ("GET", "/api/config/maps"): SIGNED_IN,
    ("GET", "/api/config/field-schema"): P.PROJECTS_VIEW,
    ("GET", "/api/config/store-fields"): P.PROJECTS_VIEW,
    # Google lookups cost money and only serve editing.
    ("GET", "/api/places/validate"): P.PROJECTS_EDIT,
    ("GET", "/api/places/search"): P.PROJECTS_EDIT,
    ("GET", "/api/places/autocomplete"): P.PROJECTS_EDIT,
    # Projects
    ("GET", "/api/projects"): P.PROJECTS_VIEW,
    ("POST", "/api/projects"): P.PROJECTS_EDIT,
    ("GET", _PROJECT): P.PROJECTS_VIEW,
    ("PATCH", _PROJECT): P.PROJECTS_EDIT,
    ("DELETE", _PROJECT): P.PROJECTS_EDIT,
    ("GET", _PROJECT + "/uploads"): P.PROJECTS_VIEW,
    ("GET", _PROJECT + "/uploads/{upload_id}/file"): P.PROJECTS_VIEW,
    ("GET", _PROJECT + "/routes"): P.PROJECTS_VIEW,
    ("POST", _PROJECT + "/installers"): P.PROJECTS_EDIT,
    ("POST", _PROJECT + "/installers/rename"): P.PROJECTS_EDIT,
    ("POST", _PROJECT + "/routing/rebalance"): P.PROJECTS_EDIT,
    ("POST", _PROJECT + "/routing/recluster"): P.PROJECTS_EDIT,
    ("POST", _PROJECT + "/stops/{stop_uid}/reassign"): P.PROJECTS_EDIT,
    ("POST", _PROJECT + "/screen-sheet"): P.PROJECTS_EDIT,
    # Stores
    ("GET", _PROJECT + "/stores"): P.PROJECTS_VIEW,
    ("POST", _PROJECT + "/stores"): P.PROJECTS_EDIT,
    ("GET", _PROJECT + "/stores/screens"): P.PROJECTS_VIEW,
    ("GET", _PROJECT + "/stores/pins"): P.PROJECTS_VIEW,
    ("GET", _PROJECT + "/stores/filters"): P.PROJECTS_VIEW,
    ("GET", _PROJECT + "/stores/hardware"): P.PROJECTS_VIEW,
    ("GET", _PROJECT + "/stores/by-state"): P.PROJECTS_VIEW,
    ("GET", _PROJECT + "/stores/field-usage"): P.PROJECTS_VIEW,
    ("GET", _PROJECT + "/stores/export.csv"): P.PROJECTS_VIEW,
    ("POST", _PROJECT + "/stores/append"): P.PROJECTS_EDIT,
    ("GET", _PROJECT + "/stores/overview"): P.PROJECTS_VIEW,
    ("GET", _STORE): P.PROJECTS_VIEW,
    ("DELETE", _STORE): P.STORES_DELETE,
    ("PUT", _STORE + "/external-id"): P.PROJECTS_EDIT,
    # Open to whoever logs visits; the handler then holds them to a store on a route and to a few fields
    # (domain.auth.store_edit_problem).
    ("PATCH", _STORE): P.VISITS_LOG,
    ("PUT", _STORE + "/screens"): P.VISITS_LOG,
    ("PATCH", _STORE + "/progress"): P.VISITS_LOG,
    ("GET", _STORE + "/visits"): P.PROJECTS_VIEW,
    ("POST", _STORE + "/visits"): P.VISITS_LOG,
    # Sheets
    ("POST", "/api/jobs/imports"): P.PROJECTS_EDIT,
    ("PUT", "/api/jobs/{job_id}/upload"): P.PROJECTS_EDIT,
    ("POST", "/api/jobs/{job_id}/start"): P.PROJECTS_EDIT,
    ("GET", "/api/jobs/{job_id}"): P.PROJECTS_VIEW,
    ("GET", "/api/jobs/{job_id}/result"): P.PROJECTS_VIEW,
    ("POST", "/api/jobs/{job_id}/mapping"): P.PROJECTS_EDIT,
    # Lists
    ("GET", "/api/lists/categories"): P.PROJECTS_VIEW,
    ("PUT", "/api/lists/categories"): P.PROJECTS_EDIT,
    ("GET", "/api/lists/installers/work"): P.PROJECTS_VIEW,
    ("POST", "/api/lists/installers/sync"): P.INSTALLERS_MANAGE,
    ("GET", "/api/lists/{kind}"): P.PROJECTS_VIEW,
    ("POST", "/api/lists/{kind}"): P.INSTALLERS_MANAGE,
    ("PUT", "/api/lists/installers/{name}"): P.INSTALLERS_MANAGE,
    ("DELETE", "/api/lists/{kind}/{value}"): P.INSTALLERS_MANAGE,
    # Route plans
    ("GET", "/api/store-search"): P.ROUTES_VIEW,
    ("GET", "/api/store-search/pins"): P.ROUTES_VIEW,
    ("GET", "/api/store-search/facets"): P.ROUTES_VIEW,
    ("POST", "/api/store-search/venues/refresh"): P.ROUTES_MANAGE,
    ("GET", "/api/route-plans"): P.ROUTES_VIEW,
    ("POST", "/api/route-plans"): P.ROUTES_MANAGE,
    ("POST", "/api/route-plans/preview"): P.ROUTES_MANAGE,
    ("GET", _PLAN): P.ROUTES_VIEW,
    ("PATCH", _PLAN): P.ROUTES_MANAGE,
    ("POST", _PLAN + "/stores"): P.ROUTES_MANAGE,
    ("POST", _PLAN + "/next-day"): P.ROUTES_MANAGE,
    ("POST", _PLAN + "/close"): P.ROUTES_MANAGE,
    ("POST", _PLAN + "/days/insert-options"): P.ROUTES_MANAGE,
    ("POST", _PLAN + "/days/insert"): P.ROUTES_MANAGE,
    ("POST", _PLAN + "/days/lock"): P.ROUTES_ARRANGE,
    ("DELETE", _PLAN_STOP): P.ROUTES_MANAGE,  # out of the route for good
    ("POST", _PLAN_STOP + "/restore"): P.ROUTES_MANAGE,  # a set-aside store back onto a day
    ("POST", _PLAN_STOP + "/set-aside"): P.ROUTES_ARRANGE,  # off its day, kept with the route
    ("POST", _PLAN_STOP + "/reassign"): P.ROUTES_ARRANGE,
    ("POST", _PLAN_STOP + "/move"): P.ROUTES_ARRANGE,  # to another plan needs routes.manage (the handler checks)
    ("POST", _PLAN_STOP + "/mark"): P.ROUTES_ARRANGE,
    ("POST", _PLAN_STOP + "/next-day"): P.ROUTES_ARRANGE,
    # A technician's own
    ("GET", "/api/my/route"): P.ROUTES_OWN,
    ("PUT", "/api/my/profile"): P.ROUTES_OWN,
    # Dolphin data
    ("GET", "/api/device-data/pas"): P.PROJECTS_VIEW,
    ("POST", _PROJECT + "/device-sync"): P.PROJECTS_EDIT,
    ("POST", _PROJECT + "/device-sync/populate"): P.PROJECTS_EDIT,
    ("GET", _PROJECT + "/device-sync/review"): P.PROJECTS_VIEW,
    ("POST", _PROJECT + "/device-sync/review/{key}/add"): P.PROJECTS_EDIT,
    ("POST", _PROJECT + "/device-sync/review/{key}/snooze"): P.PROJECTS_EDIT,
    ("POST", _PROJECT + "/device-sync/overwrite"): P.PROJECTS_EDIT,
    ("POST", _STORE + "/device-overwrite"): P.PROJECTS_EDIT,
    ("GET", _STORE + "/device-logs"): P.PROJECTS_VIEW,
    ("POST", _STORE + "/device-alert/ignore"): P.PROJECTS_EDIT,
}

ALGORITHMS = ["RS256", "ES256", "EdDSA"]  # asymmetric only: this app never holds a key that could sign a token


@lru_cache
def _jwks(url: str) -> jwt.PyJWKClient:
    return jwt.PyJWKClient(url, cache_keys=True, lifespan=3600)  # one per warm process


def _signing_key(token: str, settings: Settings) -> Any:
    if settings.auth_public_key:
        return settings.auth_public_key.replace("\\n", "\n")
    if not settings.auth_jwks_url:
        raise HTTPException(status_code=500, detail="Sign-in is not configured (no key to check tokens with)")
    return _jwks(settings.auth_jwks_url).get_signing_key_from_jwt(token).key


def principal_from_claims(claims: dict[str, Any], settings: Settings) -> Principal:
    role = role_from_groups(claims.get(settings.auth_role_claim), settings.auth_app)
    if role is None:
        raise HTTPException(status_code=403, detail="Your account has no role in Dolphin Tracker")
    # RFC 8693: who is really signed in, when acting as someone else. (Cognito never sends it.)
    actor = claims.get("act")
    actor = actor if isinstance(actor, dict) else {}
    acting_by = str(actor.get("name") or actor.get("email") or actor.get("sub") or "")
    return principal(
        id=str(claims["sub"]), name=str(claims.get("name") or ""), email=str(claims.get("email") or ""), role=role,
        acting_by=acting_by,  # a technician is linked to their Installers entry by email (services/technician.py)
    )


def _from_token(request: Request, settings: Settings) -> Principal:
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(status_code=401, detail="Sign in to use Dolphin Tracker")
    if not (settings.auth_issuer and settings.auth_audience):
        raise HTTPException(status_code=500, detail="Sign-in is not configured (issuer and client ID)")
    try:
        claims = jwt.decode(
            token.strip(), _signing_key(token.strip(), settings), algorithms=ALGORITHMS,
            issuer=settings.auth_issuer, audience=settings.auth_audience,
            options={"require": ["exp", "iss", "aud", "sub"]}, leeway=30,
        )
    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(status_code=401, detail="Your sign-in has expired") from exc
    except jwt.PyJWTError as exc:  # bad signature, issuer, audience, shape; or the keys could not be fetched
        raise HTTPException(status_code=401, detail="Your sign-in is not valid") from exc
    if claims.get("token_use") != "id":  # the pool's access token has no email, name or `aud`: only the ID token
        raise HTTPException(status_code=401, detail="Your sign-in is not valid")
    return principal_from_claims(claims, settings)


def _local(request: Request) -> Principal:
    """No login (local work): a Super Admin, or the role named in X-Dev-Role to try the app as someone else."""
    role = parse_role(request.headers.get("x-dev-role")) or Role.SUPER_ADMIN
    return principal(id="local", name="Local user", role=role, installer_id=request.headers.get("x-dev-installer", ""))


def get_principal(request: Request, settings: Annotated[Settings, Depends(get_settings)]) -> Principal:
    cached = getattr(request.state, "principal", None)
    if cached is None:
        cached = _from_token(request, settings) if settings.auth_mode == "jwt" else _local(request)
        request.state.principal = cached
    return cached


PrincipalDep = Annotated[Principal, Depends(get_principal)]


def enforce(request: Request, settings: Annotated[Settings, Depends(get_settings)]) -> None:
    """On every /api route: the route's rule from POLICY, checked against the caller."""
    path = getattr(request.scope.get("route"), "path", "")
    if not path.startswith("/api"):  # some FastAPI versions give the path below the /api router
        path = "/api" + path
    rule = POLICY.get((request.method, path.rstrip("/") or "/api"))
    if rule == PUBLIC:
        return
    who = get_principal(request, settings)
    if rule is None:  # not in the table: closed, whoever asks
        raise HTTPException(status_code=403, detail="This action is not open to anyone yet")
    if rule != SIGNED_IN and not who.can(Permission(rule)):
        raise HTTPException(status_code=403, detail="You do not have permission to do this")


def require(who: Principal, permission: Permission, message: str = "You do not have permission to do this") -> None:
    if not who.can(permission):
        raise HTTPException(status_code=403, detail=message)
