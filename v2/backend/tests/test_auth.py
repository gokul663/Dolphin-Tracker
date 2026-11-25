"""Roles and sign-in: every endpoint has a rule, each role gets what was agreed, and tokens are checked."""
import time
import unittest
from types import SimpleNamespace

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from dolphin_tracker.api.app import create_app
from dolphin_tracker.api.auth import POLICY, PUBLIC, SIGNED_IN
from dolphin_tracker.api.deps import get_project_repository, get_store_repository
from dolphin_tracker.config import Settings, get_settings
from dolphin_tracker.domain.auth import (
    ROLE_PERMISSIONS,
    SERVICE_STORE_FIELDS,
    Permission,
    Role,
    parse_role,
    principal,
    role_from_groups,
    store_edit_problem,
)
from dolphin_tracker.domain.lists import NameEntry
from dolphin_tracker.services.technician import TechnicianService
from tests.test_stores_api import StoresApiTestCase

P = Permission


def may(role: Role, method: str, path: str) -> bool:
    rule = POLICY[(method, path)]
    return rule in (PUBLIC, SIGNED_IN) or rule in ROLE_PERMISSIONS[role]


class PolicyTests(unittest.TestCase):
    def test_every_endpoint_has_a_rule_and_no_rule_is_stale(self):
        spec = create_app().openapi()
        routes = {(method.upper(), path) for path, operations in spec["paths"].items() for method in operations}
        self.assertEqual(routes - set(POLICY), set(), "endpoints with no rule in api/auth.py POLICY")
        self.assertEqual(set(POLICY) - routes, set(), "rules for endpoints that no longer exist")

    def test_what_each_role_may_do(self):
        plan, stop = "/api/route-plans/{plan_id}", "/api/route-plans/{plan_id}/stops/{project_id}/{stop_uid}"
        store = "/api/projects/{project_id}/stores/{stop_uid}"
        cases = {
            # (method, path): the roles that may
            ("GET", "/api/projects"): "super_admin admin operator viewer",
            ("POST", "/api/projects"): "super_admin admin",
            ("PATCH", "/api/projects/{project_id}"): "super_admin admin",
            ("POST", "/api/jobs/imports"): "super_admin admin",  # add a sheet
            ("PUT", "/api/lists/installers/{name}"): "super_admin admin",
            ("GET", plan): "super_admin admin operator viewer",
            ("POST", "/api/route-plans"): "super_admin admin",
            ("POST", plan + "/stores"): "super_admin admin",  # add stores to a route
            ("POST", plan + "/days/insert"): "super_admin admin",
            ("POST", plan + "/close"): "super_admin admin",
            ("DELETE", stop): "super_admin admin",  # out of the route for good
            ("POST", stop + "/restore"): "super_admin admin",
            ("POST", stop + "/set-aside"): "super_admin admin operator",  # off its day, kept with the route
            ("POST", stop + "/move"): "super_admin admin operator",
            ("POST", stop + "/reassign"): "super_admin admin operator",
            ("POST", stop + "/mark"): "super_admin admin operator",
            ("DELETE", store): "super_admin admin",  # delete a store for good
            ("POST", store + "/visits"): "super_admin admin operator",
            ("PUT", store + "/screens"): "super_admin admin operator",
            ("GET", store + "/visits"): "super_admin admin operator viewer",
            ("GET", "/api/me"): "super_admin admin operator viewer technician",
        }
        for (method, path), allowed in cases.items():
            with self.subTest(method=method, path=path):
                self.assertEqual({role.value for role in Role if may(role, method, path)}, set(allowed.split()))

    def test_a_viewer_changes_nothing_and_a_technician_reaches_only_their_own(self):
        for (method, path), rule in POLICY.items():
            if method != "GET" and rule not in (PUBLIC, SIGNED_IN):
                self.assertFalse(may(Role.VIEWER, method, path), f"viewer may {method} {path}")
            if rule not in (PUBLIC, SIGNED_IN):
                self.assertEqual(may(Role.TECHNICIAN, method, path), path.startswith("/api/my/"), f"{method} {path}")
                if path.startswith("/api/my/"):  # nobody else's: not even an admin's
                    self.assertFalse(may(Role.ADMIN, method, path))
        self.assertEqual(ROLE_PERMISSIONS[Role.SUPER_ADMIN], ROLE_PERMISSIONS[Role.ADMIN])  # the same, for now

    def test_role_names_as_a_token_may_spell_them(self):
        self.assertEqual([parse_role(text) for text in ("Super Admin", "super-admin", "OPERATOR", "boss", None)],
                         [Role.SUPER_ADMIN, Role.SUPER_ADMIN, Role.OPERATOR, None, None])

    def test_store_edits_of_someone_who_only_logs_visits(self):
        operator, viewer = principal(id="o", role=Role.OPERATOR), principal(id="v", role=Role.VIEWER)
        admin = principal(id="a", role=Role.ADMIN)
        self.assertEqual(store_edit_problem(admin, False, {"store_name"}, SERVICE_STORE_FIELDS), "")
        self.assertEqual(store_edit_problem(operator, True, {"store_ssid"}, SERVICE_STORE_FIELDS), "")
        self.assertIn("on an active route", store_edit_problem(operator, False, {"store_ssid"}, SERVICE_STORE_FIELDS))
        self.assertIn("store_name", store_edit_problem(operator, True, {"store_name"}, SERVICE_STORE_FIELDS))
        self.assertIn("permission", store_edit_problem(viewer, True, {"store_ssid"}, SERVICE_STORE_FIELDS))


class LocalRoleTests(unittest.TestCase):
    """No login (auth off): a Super Admin, or the role in X-Dev-Role. Refusals come before any data is read."""

    def setUp(self):
        self.client = TestClient(create_app())

    def test_me_and_refusals(self):
        me = self.client.get("/api/me").json()
        self.assertEqual((me["role"], "routes.manage" in me["permissions"]), ("super_admin", True))
        as_viewer = {"X-Dev-Role": "viewer"}
        self.assertEqual(self.client.get("/api/me", headers=as_viewer).json()["permissions"],
                         ["projects.view", "routes.view"])
        self.assertEqual(self.client.post("/api/projects", json={}, headers=as_viewer).status_code, 403)
        self.assertEqual(self.client.post("/api/route-plans", json={}, headers={"X-Dev-Role": "operator"}).status_code,
                         403)
        self.assertEqual(self.client.get("/api/projects", headers={"X-Dev-Role": "technician"}).status_code, 403)
        self.assertEqual(self.client.get("/api/health", headers={"X-Dev-Role": "technician"}).status_code, 200)


class OperatorStoreEditTests(StoresApiTestCase):
    """An Operator edits a store only while it is on a route, and only what a visit touches."""

    OPERATOR = {"X-Dev-Role": "operator"}

    def test_only_on_a_route_and_only_some_fields(self):
        wifi = {"store_ssid": "Shop"}
        refused = self.client.patch("/api/projects/p1/stores/a", json=wifi, headers=self.OPERATOR)
        self.assertEqual((refused.status_code, "active route" in refused.text), (403, True))
        self.stores.claim_for_plan("p1", ["a"], "plan1", "2026-11-06T00:00:00+00:00")
        self.assertEqual(self.client.patch("/api/projects/p1/stores/a", json=wifi, headers=self.OPERATOR).status_code,
                         200)
        renamed = self.client.patch("/api/projects/p1/stores/a", json={"store_name": "New"}, headers=self.OPERATOR)
        self.assertEqual((renamed.status_code, "store_name" in renamed.text), (403, True))
        comment = self.client.patch("/api/projects/p1/stores/a/progress", json={"comment": "hi"},
                                    headers=self.OPERATOR)
        self.assertEqual(comment.status_code, 200, comment.text)
        self.assertEqual(self.client.patch("/api/projects/p1/stores/a", json=wifi,
                                           headers={"X-Dev-Role": "viewer"}).status_code, 403)
        self.assertEqual(self.client.patch("/api/projects/p1/stores/b", json=wifi).status_code, 200)  # an admin


KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PUBLIC_PEM = KEY.public_key().public_bytes(serialization.Encoding.PEM,
                                           serialization.PublicFormat.SubjectPublicKeyInfo).decode()
ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool"
CLIENT_ID = "tracker-client-id"


def token(key=KEY, **claims) -> str:
    """An ID token as the Nexus user pool signs it for Tracker's app client."""
    body = {"sub": "u1", "name": "Dana", "email": "dana@example.com", "cognito:groups": ["tracker:operator"],
            "token_use": "id", "iss": ISSUER, "aud": CLIENT_ID, "exp": int(time.time()) + 300, **claims}
    return jwt.encode({k: v for k, v in body.items() if v is not None}, key, algorithm="RS256")


def groups(*names: str) -> dict:
    return {"cognito:groups": list(names)}


class TokenTests(unittest.TestCase):
    def setUp(self):
        self.app = create_app()
        settings = Settings(auth_mode="jwt", auth_issuer=ISSUER, auth_audience=CLIENT_ID, auth_public_key=PUBLIC_PEM)
        self.app.dependency_overrides[get_settings] = lambda: settings
        self.client = TestClient(self.app)

    def me(self, bearer: str | None, **headers):
        if bearer is not None:
            headers["Authorization"] = f"Bearer {bearer}"
        return self.client.get("/api/me", headers=headers)

    def test_the_defaults_read_the_nexus_groups(self):
        settings = Settings(_env_file=None)
        self.assertEqual((settings.auth_mode, settings.auth_role_claim, settings.auth_app),
                         ("off", "cognito:groups", "tracker"))

    def test_a_signed_token_says_who_and_the_role_comes_from_the_groups(self):
        me = self.me(token(**groups("venue-vision:viewer", "tracker:operator", "nexus:admin"))).json()
        self.assertEqual((me["id"], me["name"], me["email"], me["role"]),
                         ("u1", "Dana", "dana@example.com", "operator"))
        self.assertIn("visits.log", me["permissions"])
        self.assertEqual(me["installer_id"], "")  # a technician is matched by email, not by a claim
        self.assertEqual(self.client.get("/api/health").status_code, 200)  # open without a token

    def test_of_several_tracker_groups_the_most_privileged_wins(self):
        cases = {
            ("tracker:technician", "tracker:viewer"): "viewer",
            ("tracker:viewer", "tracker:operator", "tracker:technician"): "operator",
            ("tracker:operator", "tracker:admin"): "admin",
            ("tracker:admin", "tracker:super_admin", "tracker:viewer"): "super_admin",
            ("tracker:technician", "venue-vision:admin"): "technician",  # another app's admin is not ours
            ("tracker:boss", "tracker:viewer"): "viewer",  # a group this app does not know is skipped
        }
        for held, role in cases.items():
            with self.subTest(held):
                self.assertEqual(self.me(token(**groups(*held))).json()["role"], role)
        self.assertEqual(role_from_groups(["tracker:admin"], "tracker"), Role.ADMIN)
        self.assertEqual([role_from_groups(value, "tracker") for value in (None, "tracker:admin", [], [7])],
                         [None, None, None, None])

    def test_acting_as_someone_else_is_still_read(self):
        me = self.me(token(act={"sub": "boss", "name": "Sam"})).json()
        self.assertEqual(me["acting_by"], "Sam")

    def test_what_is_refused(self):
        other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cases = {
            "no token": (self.me(None), 401),
            "the dev header is not a way in": (self.me(None, **{"X-Dev-Role": "admin"}), 401),
            "signed by someone else": (self.me(token(key=other)), 401),
            "for another app's client": (self.me(token(aud="venue-vision-client-id")), 401),
            "no audience": (self.me(token(aud=None)), 401),
            "an access token": (self.me(token(token_use="access")), 401),
            "no token_use": (self.me(token(token_use=None)), 401),
            "from another pool": (self.me(token(iss=ISSUER + "x")), 401),
            "expired": (self.me(token(exp=int(time.time()) - 3600)), 401),
            "no expiry": (self.me(token(exp=None)), 401),
            "unsigned": (self.me(jwt.encode({"sub": "u1", "cognito:groups": ["tracker:admin"], "token_use": "id",
                                             "iss": ISSUER, "aud": CLIENT_ID, "exp": int(time.time()) + 300}, "",
                                            algorithm="none")), 401),
            "no tracker group": (self.me(token(**groups("venue-vision:admin", "nexus:admin"))), 403),
            "no groups at all": (self.me(token(**{"cognito:groups": None})), 403),
            "an unknown tracker role": (self.me(token(**groups("tracker:boss"))), 403),
            "a bare role name is not a group": (self.me(token(**groups("admin"))), 403),
            "the old role claim is not read": (self.me(token(role="admin", **{"cognito:groups": None})), 403),
        }
        for name, (response, status) in cases.items():
            with self.subTest(name):
                self.assertEqual(response.status_code, status, response.text)
        self.assertIn("no role in Dolphin Tracker", self.me(token(**groups("nexus:admin"))).json()["detail"])
        viewer = {"Authorization": f"Bearer {token(**groups('tracker:viewer'))}"}
        self.assertEqual(self.client.post("/api/projects", json={}, headers=viewer).status_code, 403)
        _ = (get_project_repository, get_store_repository)  # (data is never reached by a refused call)


class TechnicianLinkTests(unittest.TestCase):
    """A signed-in technician is their Installers entry by email (there is no installer claim in the token)."""

    def test_by_email_or_additional_email_whatever_the_case(self):
        entries = [NameEntry(id="i1", value="Ann Smith", email="ann@example.com"),
                   NameEntry(id="i2", value="Bo Lee", email="bo@work.com", email2="Bo.Lee@Example.com")]
        lists = SimpleNamespace(names=lambda kind, limit: SimpleNamespace(items=entries))
        service = TechnicianService(lists, None, None, None, None)

        def found(email: str) -> str | None:
            entry = service.installer_for(principal(id="u", role=Role.TECHNICIAN, email=email))
            return entry.value if entry else None

        self.assertEqual([found("ANN@example.com"), found("bo.lee@example.com"), found("zed@example.com"), found("")],
                         ["Ann Smith", "Bo Lee", None, None])
