import unittest
from decimal import Decimal

from dolphin_tracker.repositories.dynamo import Keys, decode_cursor, encode_cursor, from_ddb, to_ddb


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

    def test_keys(self):
        self.assertEqual(Keys.project("p1"), {"PK": "PROJECT#p1", "SK": "META"})
        self.assertEqual(Keys.stop("p1", "u1"), {"PK": "PROJECT#p1", "SK": "STOP#u1"})
        self.assertEqual(Keys.job("j1"), {"PK": "JOB#j1", "SK": "META"})
