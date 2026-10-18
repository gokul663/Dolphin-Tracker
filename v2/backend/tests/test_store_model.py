"""Store model v2 (STORE-MODEL §2–§4): statuses, derivation, screens, field rules."""
import unittest

from dolphin_tracker.domain.models import (
    PENDING_STATUSES,
    STATUS_PRECEDENCE,
    Screen,
    ScreenInput,
    ScreenStatus,
    Stop,
    StopInput,
    derive_store_status,
    normalize_screen_status,
)
from dolphin_tracker.domain.validation import (
    EDITABLE_FIELDS,
    FIELDS_BY_NAME,
    STORE_FIELDS,
    Group,
    field_error,
    normalize_external_id,
    parse_count,
    parse_tri_state,
    stop_details,
    validate_store_values,
)

S = ScreenStatus


class DerivedStatusTests(unittest.TestCase):
    def test_precedence_matches_the_spec(self):
        self.assertEqual(
            [status.value for status in STATUS_PRECEDENCE],
            ["Upcoming", "Invitation Email Sent", "Shipped", "Delivered", "Offline", "Completed", "Archived",
             "Cancelled"],
        )
        self.assertEqual(set(STATUS_PRECEDENCE), set(ScreenStatus))

    def test_least_progressed_screen_wins(self):
        self.assertEqual(derive_store_status([S.COMPLETED, S.UPCOMING]), S.UPCOMING)
        self.assertEqual(derive_store_status([S.COMPLETED, S.CANCELLED]), S.COMPLETED)
        self.assertEqual(derive_store_status([S.CANCELLED, S.CANCELLED]), S.CANCELLED)
        self.assertEqual(derive_store_status([S.COMPLETED, S.OFFLINE]), S.OFFLINE)
        self.assertEqual(derive_store_status([S.DELIVERED, S.SHIPPED, S.COMPLETED]), S.SHIPPED)
        self.assertEqual(derive_store_status([Screen(status=S.ARCHIVED), "Completed"]), S.COMPLETED)
        self.assertEqual(derive_store_status([]), S.UPCOMING)

    def test_pending_set(self):
        self.assertEqual(PENDING_STATUSES, {S.UPCOMING, S.INVITATION_EMAIL_SENT, S.SHIPPED, S.DELIVERED})
        self.assertNotIn(S.OFFLINE, PENDING_STATUSES)  # STORE-MODEL §7 #2

    def test_stop_status_is_always_derived_from_its_screens(self):
        stop = Stop(uid="u", store_name="A", addr="1 Main", status=S.COMPLETED,
                    screens=[{"status": "Completed"}, {"status": "Shipped"}])
        self.assertEqual(stop.status, S.SHIPPED)  # the passed status is ignored
        dumped = Stop.model_validate(stop.model_dump(mode="json"))
        self.assertEqual((dumped.status, [screen.id for screen in dumped.screens]),
                         (S.SHIPPED, [screen.id for screen in stop.screens]))

    def test_a_stop_always_has_a_screen(self):
        stop = Stop(uid="u", store_name="A", addr="1 Main")
        self.assertEqual(len(stop.screens), 1)
        self.assertEqual((stop.screens[0].status, stop.screens[0].is_dolphin_screen), (S.UPCOMING, True))
        self.assertFalse(stop.screens[0].has_mount or stop.screens[0].has_ceiling_mount)  # wall mount default

    def test_items_written_before_v2_read_as_one_screen(self):
        for legacy, expected in [("Incomplete", S.UPCOMING), ("Complete", S.COMPLETED),
                                 ("Technical Issue", S.OFFLINE), ("Other", S.UPCOMING)]:
            with self.subTest(legacy=legacy):
                stop = Stop.model_validate({"uid": "u", "store_name": "A", "addr": "1", "status": legacy})
                self.assertEqual((stop.status, [screen.status for screen in stop.screens]), (expected, [expected]))


class SheetStatusAliasTests(unittest.TestCase):
    def test_aliases_case_insensitive_after_trim(self):
        cases = {
            " Installed ": S.COMPLETED, "DONE": S.COMPLETED, "complete": S.COMPLETED,
            "technician": S.UPCOMING, "Scheduled": S.UPCOMING, "": S.UPCOMING, None: S.UPCOMING,
            "invited": S.INVITATION_EMAIL_SENT, "Invitation  Email Sent": S.INVITATION_EMAIL_SENT,
            "shipped": S.SHIPPED, "Delivered": S.DELIVERED, "offline": S.OFFLINE, "archived": S.ARCHIVED,
            "canceled": S.CANCELLED, "Cancelled": S.CANCELLED,
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(normalize_screen_status(raw), (expected, True))

    def test_unknown_values_default_to_upcoming_and_are_flagged(self):
        self.assertEqual(normalize_screen_status("on hold"), (S.UPCOMING, False))


class ScreenInputTests(unittest.TestCase):
    def test_ids_are_minted_or_kept(self):
        self.assertEqual(ScreenInput(id="keep").to_screen().id, "keep")
        minted = ScreenInput().to_screen().id
        self.assertEqual(len(minted), 32)
        self.assertNotEqual(minted, ScreenInput().to_screen().id)

    def test_stop_input_builds_one_screen_by_default(self):
        self.assertEqual([s.status for s in StopInput(store_name="A", addr="1").build_screens()], [S.UPCOMING])
        done = StopInput(store_name="A", addr="1", initial_status=S.COMPLETED).build_screens()
        self.assertEqual([s.status for s in done], [S.COMPLETED])
        two = StopInput(store_name="A", addr="1", screens=[{"stick_number": "7"}, {"is_dolphin_screen": False}])
        rows = [(s.stick_number, s.is_dolphin_screen) for s in two.build_screens()]
        self.assertEqual(rows, [("7", True), ("", False)])


class ParsingRuleTests(unittest.TestCase):
    def test_tri_state(self):
        for raw in ("Yes", "TRUE", "true", "y", "1", True):
            self.assertIs(parse_tri_state(raw), True, raw)
        for raw in ("No", "FALSE", "n", "0", False):
            self.assertIs(parse_tri_state(raw), False, raw)
        for raw in ("", None, "Unsure", "N/A", "maybe"):
            self.assertIsNone(parse_tri_state(raw), raw)

    def test_counts(self):
        # The first whole number in the text ("3.0" → 3); floats only when integral; bool is not a count.
        cases = {"3": 3, "3.0": 3, 3.0: 3, 4: 4, "Only 1 Stick": 1, "": None, None: None, "two": None, True: None}
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(parse_count(raw), expected)

    def test_external_id_normalisation(self):
        self.assertEqual(normalize_external_id("  ibc-12  a "), "IBC-12 A")
        self.assertEqual(normalize_external_id(None), "")


class FieldRuleTests(unittest.TestCase):
    def test_registry_follows_the_drawer_order_and_marks_read_only_fields(self):
        groups = list(dict.fromkeys(field.group for field in STORE_FIELDS))
        self.assertEqual(groups, [Group.IDENTITY, Group.CONTACTS, Group.INSTALLATION, Group.SITE_NOTES,
                                  Group.SITE_CHECKLIST, Group.SCREENS])
        self.assertNotIn("external_id", EDITABLE_FIELDS)
        self.assertNotIn("pa", EDITABLE_FIELDS)
        self.assertIn("committed_dolphin_screens", EDITABLE_FIELDS)  # STORE-MODEL §7 #1
        required = {field.name for field in STORE_FIELDS if field.required}
        self.assertEqual(required, {"external_id", "store_name", "addr"})

    def test_per_kind_rules(self):
        ok = {
            "onsite_contact_phone": "(404) 555-0100 x12", "owner_email": "a@b.co",
            "image_url": "see https://x.test/a.jpg, https://x.test/b.jpg", "outlet_status": "Existing",
            "committed_dolphin_screens": 0, "cms_details_added": True, "spot_visible": None, "store_ssid": "any text",
        }
        self.assertEqual(validate_store_values(ok, partial=True), {})
        bad = {
            "owner_phone": "call me", "owner_email": "nope", "image_url": "drive folder", "outlet_status": "Old",
            "committed_store_tvs": -1, "spot_visible": "yes",
        }
        self.assertEqual(set(validate_store_values(bad, partial=True)), set(bad))
        self.assertIsNotNone(field_error(FIELDS_BY_NAME["committed_store_tvs"], True))  # bool is not a count

    def test_required_fields(self):
        self.assertEqual(set(validate_store_values({})), {"external_id", "store_name", "addr"})
        blanked = validate_store_values({"store_name": "  "}, partial=True)
        self.assertEqual(blanked, {"store_name": "Store name is required"})
        self.assertEqual(validate_store_values({"dma": ""}, partial=True), {})

    def test_stop_details_cleans_for_storage(self):
        source = StopInput(store_name="A", addr="1", external_id=" ibc 9 ", dma=" ATL ", spot_visible=False)
        details = stop_details(source)
        self.assertEqual((details["external_id"], details["dma"], details["spot_visible"]), ("IBC 9", "ATL", False))
        self.assertNotIn("store_name", details)
        self.assertNotIn("addr", details)
