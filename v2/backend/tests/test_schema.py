import unittest

from dolphin_tracker.domain.models import FieldDef, FieldType
from dolphin_tracker.domain.schema import (
    DEFAULT_FIELD_SCHEMA,
    coerce_fields,
    default_field_schema,
    validate_fields,
    validate_schema,
)

SCHEMA = [
    FieldDef(key="venue_code", label="Venue Code", required=True),
    FieldDef(key="owner_phone", label="Owner Phone", type=FieldType.PHONE),
    FieldDef(key="owner_email", label="Owner Email", type=FieldType.EMAIL),
    FieldDef(key="screens", label="Screens", type=FieldType.NUMBER),
    FieldDef(key="tier", label="Tier", type=FieldType.SELECT, options=["Gold", "Silver"]),
    FieldDef(key="install_date", label="Install Date", type=FieldType.DATE),
]


class DefaultSchemaTests(unittest.TestCase):
    def test_default_schema_matches_handoff(self):
        keys = [field.key for field in DEFAULT_FIELD_SCHEMA]
        self.assertEqual(
            keys, ["pa", "venue_type", "dma", "venue_code", "owner_name", "owner_phone", "owner_email", "payee_name"]
        )
        types = {field.key: field.type for field in DEFAULT_FIELD_SCHEMA}
        self.assertEqual(types["owner_phone"], FieldType.PHONE)
        self.assertEqual(types["owner_email"], FieldType.EMAIL)
        self.assertFalse(any(field.required for field in DEFAULT_FIELD_SCHEMA))
        self.assertEqual(validate_schema(DEFAULT_FIELD_SCHEMA), [])

    def test_default_copy_is_independent(self):
        copy = default_field_schema()
        copy[0].label = "Changed"
        self.assertEqual(DEFAULT_FIELD_SCHEMA[0].label, "PA")


class ValidateFieldsTests(unittest.TestCase):
    def test_valid_values_pass(self):
        fields = {
            "venue_code": "V1", "owner_phone": "+1 (555) 010-0100", "owner_email": "a@b.co",
            "screens": "3", "tier": "Gold", "install_date": "2026-10-16",
        }
        self.assertEqual(validate_fields(SCHEMA, fields), [])

    def test_required(self):
        self.assertEqual(validate_fields(SCHEMA, {}), ["Venue Code is required"])
        self.assertEqual(validate_fields(SCHEMA, {"venue_code": "   "}), ["Venue Code is required"])

    def test_phone(self):
        self.assertEqual(
            validate_fields(SCHEMA, {"venue_code": "V", "owner_phone": "call me"}),
            ["Owner Phone: enter a valid phone number"],
        )
        self.assertTrue(validate_fields(SCHEMA, {"venue_code": "V", "owner_phone": "12345"}))  # too short

    def test_email(self):
        self.assertEqual(
            validate_fields(SCHEMA, {"venue_code": "V", "owner_email": "nope@"}),
            ["Owner Email: enter a valid email"],
        )

    def test_number(self):
        self.assertEqual(validate_fields(SCHEMA, {"venue_code": "V", "screens": 2.5}), [])
        self.assertEqual(
            validate_fields(SCHEMA, {"venue_code": "V", "screens": "two"}), ["Screens: must be a number"]
        )
        self.assertEqual(
            validate_fields(SCHEMA, {"venue_code": "V", "screens": True}), ["Screens: must be a number"]
        )

    def test_select_options(self):
        self.assertEqual(
            validate_fields(SCHEMA, {"venue_code": "V", "tier": "Bronze"}), ["Tier: must be one of Gold, Silver"]
        )

    def test_date(self):
        self.assertEqual(
            validate_fields(SCHEMA, {"venue_code": "V", "install_date": "16/10/2026"}),
            ["Install Date: use a YYYY-MM-DD date"],
        )

    def test_blank_optional_values_skip_type_checks(self):
        self.assertEqual(validate_fields(SCHEMA, {"venue_code": "V", "owner_phone": "", "tier": None}), [])

    def test_unknown_keys_are_reported(self):
        self.assertEqual(validate_fields(SCHEMA, {"venue_code": "V", "mystery": 1}), ["Unknown field 'mystery'"])

    def test_partial_only_checks_present_keys(self):
        self.assertEqual(validate_fields(SCHEMA, {"owner_phone": "555-0100"}, partial=True), [])
        self.assertEqual(validate_fields(SCHEMA, {"venue_code": ""}, partial=True), ["Venue Code is required"])


class CoerceFieldsTests(unittest.TestCase):
    def test_coerces_by_type(self):
        coerced = coerce_fields(
            SCHEMA,
            {"venue_code": "  V1 ", "screens": "4", "owner_phone": None, "tier": "Gold", "extra": {"x": 1}},
        )
        self.assertEqual(
            coerced, {"venue_code": "V1", "screens": 4, "owner_phone": "", "tier": "Gold", "extra": {"x": 1}}
        )
        self.assertEqual(coerce_fields(SCHEMA, {"screens": "2.5"})["screens"], 2.5)
        self.assertEqual(coerce_fields(SCHEMA, {"screens": "n/a"})["screens"], "n/a")


class ValidateSchemaTests(unittest.TestCase):
    def test_rejects_bad_definitions(self):
        errors = validate_schema(
            [
                FieldDef(key="Bad Key", label="x"),
                FieldDef(key="addr", label="Address"),
                FieldDef(key="dup", label="A"),
                FieldDef(key="dup", label="B"),
                FieldDef(key="choice", label="Choice", type=FieldType.SELECT),
                FieldDef(key="nolabel", label=" "),
            ]
        )
        self.assertEqual(len(errors), 5)
        self.assertIn("Field key 'addr' is reserved", errors)
        self.assertIn("Duplicate field key 'dup'", errors)
        self.assertIn("Select field 'choice' needs at least one option", errors)
        self.assertIn("Field 'nolabel' needs a label", errors)
