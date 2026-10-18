import base64
import json
import unittest
from decimal import Decimal

from dolphin_tracker.domain.cursors import decode_cursor, encode_cursor, offset_from_cursor
from dolphin_tracker.repositories.dynamo import Keys, from_ddb, to_ddb


def wrong_shape(payload) -> str:
    """A cursor that decodes as JSON but is not a key we issued."""
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")


class SerializerTests(unittest.TestCase):
    def test_floats_become_decimals_and_back(self):
        item = to_ddb({"lat": 33.93, "count": 3, "flag": True, "nested": [{"lng": -84.5}]})
        self.assertEqual(item["lat"], Decimal("33.93"))
        self.assertEqual(item["count"], 3)
        self.assertIs(item["flag"], True)
        restored = from_ddb(item)
        self.assertEqual(restored, {"lat": 33.93, "count": 3, "flag": True, "nested": [{"lng": -84.5}]})
        self.assertIsInstance(restored["count"], int)

    def test_cursor_roundtrip(self):
        key = {"PK": "PROJECT#1", "SK": "META", "GSI1PK": "PROJECT", "GSI1SK": "2026-10-16T00:00:00+00:00"}
        cursor = encode_cursor(key)
        self.assertNotIn("=", cursor)
        self.assertEqual(decode_cursor(cursor), key)
        self.assertIsNone(encode_cursor(None))
        self.assertIsNone(decode_cursor(None))

    def test_invalid_cursor_raises(self):
        with self.assertRaises(ValueError):
            decode_cursor("not-base64!!")

    def test_decodable_cursor_of_the_wrong_shape_raises(self):
        for payload in ([1], "str", 5, None, True):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                decode_cursor(wrong_shape(payload))

    def test_cursor_encodes_dynamodb_decimals(self):
        self.assertEqual(decode_cursor(encode_cursor({"n": Decimal("3"), "x": Decimal("1.5")})), {"n": 3, "x": 1.5})

    def test_offset_cursor_rejects_non_integer_offsets(self):
        self.assertEqual(offset_from_cursor(None), 0)
        self.assertEqual(offset_from_cursor(encode_cursor({"offset": 7})), 7)
        for offset in (-1, "3", [1], 2.5, True):
            with self.subTest(offset=offset), self.assertRaises(ValueError):
                offset_from_cursor(encode_cursor({"offset": offset}))

    def test_keys(self):
        self.assertEqual(Keys.project("p1"), {"PK": "PROJECT#p1", "SK": "META"})
        self.assertEqual(Keys.stop("p1", "u1"), {"PK": "PROJECT#p1", "SK": "STOP#u1"})
        self.assertEqual(Keys.job("j1"), {"PK": "JOB#j1", "SK": "META"})
