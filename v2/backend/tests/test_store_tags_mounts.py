"""Store-level numbers worked out from the screens (mounts needed / used, the screen mismatch and its ignore) and
the store tag with its project-level options."""
import csv
import io
import unittest

from dolphin_tracker.domain import store_counts
from dolphin_tracker.domain.kpi import kpi_summary
from dolphin_tracker.domain.models import Project, Screen, Stop
from dolphin_tracker.domain.tags import DEFAULT_TAG_OPTIONS, clean_tag_options, tag_problem
from tests.test_stores_api import StoresApiTestCase


def store(*statuses: str, **values) -> Stop:
    screens = values.pop("screens", None) or [Screen(status=status) for status in statuses]
    return Stop(uid=values.pop("uid", "x"), store_name="X", addr="1 Main St", screens=screens, **values)


class MountRuleTests(unittest.TestCase):
    def test_needed_are_mounts_on_screens_not_installed_yet_used_are_mounts_on_installed_screens(self):
        def mounted(status: str, **more) -> Screen:
            return Screen(status=status, has_mount=True, **more)

        stop = store(screens=[
            mounted("Upcoming"), mounted("Shipped", screen_size="43"),
            mounted("Not Registered", has_ceiling_mount=True),
            mounted("Completed"), mounted("Offline"), mounted("Serviced - Needs More Work"), mounted("Cancelled"),
            Screen(status="Upcoming"), Screen(status="Completed"),  # no mount picked: counted nowhere
        ])
        self.assertEqual(store_counts.mounts_needed(stop), {"wall_24": 1, "wall": 1, "ceiling": 1})
        self.assertEqual(store_counts.mounts_used(stop), 3)
        self.assertEqual((stop.effective_mounts_needed_total, stop.effective_mounts_used), (3, 3))

    def test_a_typed_number_is_not_used(self):
        stop = store(screens=[Screen(status="Upcoming", has_mount=True), Screen(status="Completed", has_mount=True)],
                     wall_24_mounts_needed=0, ceiling_mounts_needed=4, mounts_used=7)  # typed or imported earlier
        self.assertEqual(stop.effective_mounts_needed, {"wall_24": 1, "wall": 0, "ceiling": 0})
        self.assertEqual(stop.effective_mounts_used, 1)

    def test_a_store_tv_without_a_size_takes_the_24_inch_mount(self):
        stop = store(screens=[Screen(status="Upcoming", has_mount=True, is_dolphin_screen=False)])
        self.assertEqual(stop.effective_mounts_needed["wall_24"], 1)


class MismatchTests(unittest.TestCase):
    def test_mismatch_and_ignore_follow_the_numbers(self):
        stop = store("Completed", committed_dolphin_screens=2, committed_store_tvs=1)
        self.assertEqual((stop.committed_screens_total, stop.installed_screens_total), (3, 1))
        self.assertTrue(stop.screen_mismatch)
        self.assertFalse(stop.mismatch_ignored)
        ignored = stop.model_copy(update={"mismatch_ignore": {"committed": 3, "rows": 1}})
        ignored = Stop.model_validate(ignored.model_dump())
        self.assertTrue(ignored.mismatch_ignored)
        self.assertTrue(ignored.screen_mismatch)  # still a mismatch for the filters
        moved = Stop.model_validate({**ignored.model_dump(), "committed_store_tvs": 2})
        self.assertFalse(moved.mismatch_ignored)  # the committed total changed: it counts again
        self.assertFalse(store("Upcoming", committed_dolphin_screens=3).screen_mismatch)  # not done yet

    def test_the_kpi_leaves_out_an_ignore_that_still_holds(self):
        rows = [
            store("Completed", uid="a", committed_dolphin_screens=3, mismatch_ignore={"committed": 3, "rows": 1}),
            store("Offline", uid="b", committed_dolphin_screens=3, mismatch_ignore={"committed": 2, "rows": 1}),
        ]
        kpi = kpi_summary(row.model_dump(mode="json") for row in rows)
        self.assertEqual((kpi.review_stores, kpi.review_screens), (1, 2))  # only b: its ignore is for 2 committed


class TagRuleTests(unittest.TestCase):
    def test_options_are_cleaned_and_a_project_starts_with_the_defaults(self):
        self.assertEqual(clean_tag_options([" Urgent ", "urgent", "", "Call  back"]), ["Urgent", "Call back"])
        project = Project.model_validate({"id": "p", "name": "P", "project_type": "offline"})
        self.assertEqual(project.tag_options, list(DEFAULT_TAG_OPTIONS))

    def test_a_tag_must_be_an_option_unless_the_store_already_carries_it(self):
        self.assertEqual(tag_problem("Done", ["Done"], ""), "")
        self.assertEqual(tag_problem("", ["Done"], "Old"), "")
        self.assertEqual(tag_problem("Old", ["Done"], "Old"), "")
        self.assertIn("not one of", tag_problem("Other", ["Done"], "Old"))


class TagApiTests(StoresApiTestCase):
    def put_tag(self, uid: str, tag: str, **headers):
        return self.client.put(f"/api/projects/p1/stores/{uid}/tag", json={"tag": tag}, headers=headers)

    def test_set_show_and_export_a_tag(self):
        response = self.put_tag("a", "In progress")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["tag"], "In progress")
        self.assertEqual(self.get("/a").json()["tag"], "In progress")
        rows = list(csv.DictReader(io.StringIO(self.get("/export.csv").text)))
        self.assertEqual({row["ID"]: row["Tag"] for row in rows}["S1"], "In progress")
        self.assertEqual(self.put_tag("a", "Nope").status_code, 422)
        self.assertEqual(self.put_tag("a", "").json()["tag"], "")

    def test_a_removed_option_stays_on_its_stores(self):
        self.put_tag("a", "Done")
        saved = self.client.put("/api/projects/p1/tag-options", json={"tag_options": ["To Do", " Escalated ", "to do"]})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["tag_options"], ["To Do", "Escalated"])
        self.assertEqual(self.get("/a").json()["tag"], "Done")  # kept
        self.assertEqual(self.put_tag("a", "Done").status_code, 200)  # saving it again is fine
        self.assertEqual(self.put_tag("b", "Done").status_code, 422)  # but no other store can take it

    def test_only_roles_with_the_tag_permission(self):
        self.assertEqual(self.put_tag("a", "Done", **{"X-Dev-Role": "operator"}).status_code, 403)
        self.assertEqual(self.client.put("/api/projects/p1/tag-options", json={"tag_options": []},
                                         headers={"X-Dev-Role": "viewer"}).status_code, 403)
        self.put_tag("a", "Done")
        self.assertEqual(self.client.get("/api/projects/p1/stores/a", headers={"X-Dev-Role": "viewer"}).json()["tag"],
                         "Done")


class MismatchApiTests(StoresApiTestCase):
    """Store "a" is Completed with 1 screen row of 2 committed: it needs review."""

    def ignore(self, uid: str, on: bool, **headers):
        return self.client.patch(f"/api/projects/p1/stores/{uid}/progress", json={"ignore_mismatch": on},
                                 headers=headers)

    def review(self) -> tuple[int, int]:
        kpi = self.client.get("/api/projects/p1").json()["kpi"]
        return kpi["review_stores"], kpi["review_screens"]

    def test_ignore_moves_the_store_out_of_needs_review_until_a_number_changes(self):
        self.assertEqual(self.review(), (1, 1))
        response = self.ignore("a", True)
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["mismatch_ignore"], {"committed": 2, "rows": 1})
        self.assertEqual((body["screen_mismatch"], body["mismatch_ignored"]), (True, True))
        self.assertEqual(self.review(), (0, 0))
        self.assertEqual(self.uids(fulfilled="Needs review"), [])
        self.assertEqual(self.uids(fulfilled="Mismatch ignored"), ["a"])
        fulfilled = [option["value"] for option in self.get("/filters").json()["fulfilled"]]
        self.assertIn("Mismatch ignored", fulfilled)
        # A third screen committed: the ignore was for 2, so the store needs review again.
        self.assertEqual(self.patch("a", {"committed_dolphin_screens": 3}).status_code, 200)
        self.assertEqual(self.review(), (1, 2))
        self.assertEqual(self.uids(fulfilled="Needs review"), ["a"])

    def test_undo_and_refusals(self):
        self.ignore("a", True)
        undone = self.ignore("a", False)
        self.assertEqual(undone.status_code, 200, undone.text)
        self.assertIsNone(undone.json()["mismatch_ignore"])
        self.assertEqual(self.review(), (1, 1))
        self.assertEqual(self.ignore("b", True).status_code, 422)  # no mismatch there
        self.assertEqual(self.ignore("a", True, **{"X-Dev-Role": "viewer"}).status_code, 403)
