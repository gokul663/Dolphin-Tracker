import unittest

import boto3
from moto import mock_aws

from dolphin_tracker.domain.cursors import encode_cursor
from dolphin_tracker.domain.errors import ConflictError, NotFoundError
from dolphin_tracker.domain.models import Screen, ScreenStatus, Stop
from dolphin_tracker.repositories.dynamo import TABLE_DEFINITION
from dolphin_tracker.repositories.memory import InMemoryStoreRepository
from dolphin_tracker.repositories.stores import DynamoStoreRepository
from tests.fakes import status_write


def make_stops(count: int, *, prefix: str = "u") -> list[Stop]:
    return [
        Stop(
            uid=f"{prefix}{index:03d}",
            display_id=f"S{index + 1}",
            store_name=f"Store {index}",
            addr=f"{index} Main St",
            state="GA",
            lat=33.75 + index * 0.001,
            lng=-84.39,
            installer="A",
            day=1 + index // 8,
            seq=index % 8,
            fields={"dma": "Atlanta", "screens": 2},
        )
        for index in range(count)
    ]


def with_ids(stops: list[Stop], prefix: str = "IBC-") -> list[Stop]:
    return [stop.model_copy(update={"external_id": f"{prefix}{index}"}) for index, stop in enumerate(stops)]


class StoreRepositoryContract:
    """Behaviour every StoreRepository must have. Subclasses provide `self.repo`."""

    repo: object

    def test_put_get_roundtrip_preserves_types(self):
        self.repo.put_many("p1", make_stops(2))
        stop = self.repo.get("p1", "u001")
        self.assertIsNotNone(stop)
        self.assertEqual(stop.lat, 33.751)
        self.assertIsInstance(stop.lat, float)
        self.assertEqual(stop.fields, {"dma": "Atlanta", "screens": 2})
        self.assertIsInstance(stop.fields["screens"], int)
        self.assertFalse(stop.route_stale)
        self.assertIsNone(self.repo.get("p1", "missing"))
        self.assertIsNone(self.repo.get("other", "u001"))

    def test_batch_of_thirty_plus_and_list_all(self):
        self.repo.put_many("p1", make_stops(37))
        self.repo.put_many("p2", make_stops(3, prefix="x"))
        everything = self.repo.list_all("p1")
        self.assertEqual(len(everything), 37)
        self.assertEqual({stop.uid for stop in everything}, {f"u{i:03d}" for i in range(37)})
        self.assertEqual(len(self.repo.list_all("p2")), 3)
        self.assertEqual(self.repo.list_all("empty"), [])

    def test_list_paginates_with_opaque_cursor(self):
        self.repo.put_many("p1", make_stops(12))
        seen: list[str] = []
        cursor = None
        pages = 0
        while True:
            page = self.repo.list("p1", limit=5, cursor=cursor)
            seen.extend(stop.uid for stop in page.items)
            pages += 1
            cursor = page.next_cursor
            if not cursor:
                break
            self.assertNotIn("STOP#", cursor)
        self.assertEqual(sorted(seen), [f"u{i:03d}" for i in range(12)])
        self.assertEqual(len(seen), len(set(seen)))
        self.assertGreaterEqual(pages, 3)

    def test_update_fields_partial_and_nested(self):
        self.repo.put_many("p1", make_stops(1))
        before = self.repo.get("p1", "u000")
        updated = self.repo.update_fields(
            "p1", "u000", status_write(ScreenStatus.COMPLETED, comment="done", **{"fields.dma": "Macon"})
        )
        self.assertEqual(updated.status, ScreenStatus.COMPLETED)
        self.assertEqual(updated.comment, "done")
        self.assertEqual(updated.fields, {"dma": "Macon", "screens": 2})
        self.assertEqual((updated.installer, updated.day, updated.seq), ("A", 1, 0))
        self.assertGreaterEqual(updated.updated_at, before.updated_at)
        self.assertEqual(self.repo.get("p1", "u000").comment, "done")

    def test_update_fields_ignores_uid_and_rejects_missing(self):
        self.repo.put_many("p1", make_stops(1))
        self.assertEqual(self.repo.update_fields("p1", "u000", {"uid": "hijack", "comment": "x"}).uid, "u000")
        with self.assertRaises(NotFoundError):
            self.repo.update_fields("p1", "nope", {"comment": "x"})

    def test_update_routing_many(self):
        self.repo.put_many("p1", make_stops(40))
        changes = [(f"u{i:03d}", {"installer": "B", "day": 9, "seq": i}) for i in range(0, 40, 2)]
        changes.append(("ghost", {"installer": "B", "day": 1, "seq": 0}))
        self.repo.update_fields("p1", "u000", status_write("Completed", comment="keep me"))
        written = self.repo.update_routing_many("p1", changes)
        self.assertEqual(written, 20)
        moved = self.repo.get("p1", "u004")
        self.assertEqual((moved.installer, moved.day, moved.seq), ("B", 9, 4))
        untouched = self.repo.get("p1", "u001")
        self.assertEqual((untouched.installer, untouched.day), ("A", 1))
        progress_kept = self.repo.get("p1", "u000")
        self.assertEqual((progress_kept.status, progress_kept.comment), (ScreenStatus.COMPLETED, "keep me"))
        self.assertIsNone(self.repo.get("p1", "ghost"))  # never created by a routing write
        self.assertEqual(self.repo.update_routing_many("p1", []), 0)

    def test_update_routing_many_rejects_non_routing_keys(self):
        self.repo.put_many("p1", make_stops(1))
        with self.assertRaises(ValueError):
            self.repo.update_routing_many("p1", [("u000", {"day": 2, "status": "Complete"})])
        self.assertEqual(self.repo.get("p1", "u000").day, 1)

    def test_delete_all_only_touches_one_project(self):
        self.repo.put_many("p1", make_stops(30))
        self.repo.put_many("p2", make_stops(2))
        self.assertEqual(self.repo.delete_all("p1"), 30)
        self.assertEqual(self.repo.list_all("p1"), [])
        self.assertEqual(len(self.repo.list_all("p2")), 2)
        self.assertEqual(self.repo.delete_all("p1"), 0)

    def test_update_progress_many_writes_only_progress_fields(self):
        self.repo.put_many("p1", make_stops(40))
        changes = [(f"u{i:03d}", {"installer_name": "Anna"}) for i in range(40)] + [("ghost", {"installer_name": "x"})]
        self.assertEqual(self.repo.update_progress_many("p1", changes), 40)  # the deleted stop is skipped
        self.assertTrue(all(stop.installer_name == "Anna" for stop in self.repo.list_all("p1")))
        with self.assertRaisesRegex(ValueError, "progress fields"):
            self.repo.update_progress_many("p1", [("u000", {"installer": "Bo"})])
        self.assertEqual(self.repo.update_progress_many("p1", []), 0)

    def test_external_id_is_unique_per_project(self):
        self.repo.put_many("p1", with_ids(make_stops(3)))
        self.repo.put_many("p1", with_ids(make_stops(1)))  # re-putting the same stop is fine
        clash = make_stops(1, prefix="x")[0].model_copy(update={"external_id": "IBC-2"})
        with self.assertRaisesRegex(ConflictError, "IBC-2 already exists"):
            self.repo.put_many("p1", [clash])
        self.assertIsNone(self.repo.get("p1", "x000"))  # the stop and its marker go together or not at all
        self.repo.put_many("p2", [clash])  # another project may use the same IBC#
        twice = [clash.model_copy(update={"uid": uid}) for uid in ("y1", "y2")]
        with self.assertRaisesRegex(ConflictError, "twice"):
            self.repo.put_many("p3", twice)

    def test_external_id_cannot_be_edited(self):
        self.repo.put_many("p1", with_ids(make_stops(1)))
        self.assertEqual(self.repo.update_fields("p1", "u000", {"external_id": "NEW"}).external_id, "IBC-0")

    def test_update_screens_writes_screens_and_the_derived_status(self):
        self.repo.put_many("p1", make_stops(1))
        before = self.repo.get("p1", "u000")
        screens = [Screen(status=ScreenStatus.COMPLETED), Screen(status=ScreenStatus.DELIVERED, venue_id="V9")]
        after = self.repo.update_screens("p1", "u000", screens, updated_by="tech@x")
        self.assertEqual([(s.id, s.status) for s in after.screens], [(s.id, s.status) for s in screens])
        self.assertEqual((after.status, after.updated_by), (ScreenStatus.DELIVERED, "tech@x"))
        self.assertEqual(after.model_dump(exclude={"screens", "status", "updated_at", "updated_by"}),
                         before.model_dump(exclude={"screens", "status", "updated_at", "updated_by"}))
        with self.assertRaises(NotFoundError):
            self.repo.update_screens("p1", "ghost", screens)

    def test_delete_all_frees_the_external_ids(self):
        self.repo.put_many("p1", with_ids(make_stops(2)))
        self.assertEqual(self.repo.delete_all("p1"), 2)
        self.repo.put_many("p1", [make_stops(1, prefix="n")[0].model_copy(update={"external_id": "IBC-0"})])


class DynamoStoreRepositoryTests(StoreRepositoryContract, unittest.TestCase):
    def setUp(self):
        # Started here rather than as a class decorator: @mock_aws only wraps methods defined on the class itself,
        # not the inherited contract tests.
        mock = mock_aws()
        mock.start()
        self.addCleanup(mock.stop)
        resource = boto3.resource("dynamodb", region_name="us-east-1")
        self.table = resource.create_table(TableName="dolphin-tracker-test", **TABLE_DEFINITION)
        self.repo = DynamoStoreRepository(self.table)

    def test_item_layout(self):
        self.repo.put_many("p1", make_stops(1))
        item = self.table.get_item(Key={"PK": "PROJECT#p1", "SK": "STOP#u000"})["Item"]
        self.assertEqual(item["entity"], "STOP")
        self.assertEqual(item["route_stale"], False)
        self.assertEqual(item["fields"]["dma"], "Atlanta")

    def test_delete_all_leaves_project_meta(self):
        self.table.put_item(Item={"PK": "PROJECT#p1", "SK": "META", "entity": "PROJECT"})
        self.repo.put_many("p1", make_stops(3))
        self.assertEqual(self.repo.delete_all("p1"), 3)
        self.assertIn("Item", self.table.get_item(Key={"PK": "PROJECT#p1", "SK": "META"}))

    def test_cursor_of_the_wrong_key_shape_is_a_value_error(self):
        self.repo.put_many("p1", make_stops(2))
        for key in ({"offset": 3}, {"PK": "PROJECT#p1", "SK": 5}, {"PK": "PROJECT#p1"}):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "Invalid cursor"):
                self.repo.list("p1", cursor=encode_cursor(key))

    def test_markers_are_items_written_with_the_stop(self):
        self.repo.put_many("p1", with_ids(make_stops(120)))  # 3 transactions of up to 50 stops
        marker = self.table.get_item(Key={"PK": "PROJECT#p1", "SK": "EXT#IBC-7"})["Item"]
        self.assertEqual((marker["entity"], marker["stop_uid"]), ("EXT", "u007"))
        self.assertEqual(len(self.repo.list_all("p1")), 120)  # markers are not stops
        clash = make_stops(1, prefix="x")[0].model_copy(update={"external_id": "IBC-119"})
        batch = [*with_ids(make_stops(3, prefix="z"), prefix="NEW-"), clash]  # one transaction
        with self.assertRaisesRegex(ConflictError, "IBC-119"):
            self.repo.put_many("p1", batch)
        self.assertIsNone(self.repo.get("p1", "z000"))  # the whole transaction was cancelled
        self.repo.delete_all("p1")
        remaining = self.table.query(KeyConditionExpression="PK = :pk", ExpressionAttributeValues={":pk": "PROJECT#p1"})
        self.assertEqual(remaining["Items"], [])

    def test_update_screens_touches_only_its_attributes(self):
        self.repo.put_many("p1", make_stops(1))
        before = self.table.get_item(Key={"PK": "PROJECT#p1", "SK": "STOP#u000"})["Item"]
        self.repo.update_screens("p1", "u000", [Screen(status=ScreenStatus.SHIPPED)])
        after = self.table.get_item(Key={"PK": "PROJECT#p1", "SK": "STOP#u000"})["Item"]
        changed = {key for key in after if after[key] != before.get(key)}
        self.assertEqual(changed, {"screens", "status", "updated_at"})


class InMemoryStoreRepositoryTests(StoreRepositoryContract, unittest.TestCase):
    def setUp(self):
        self.repo = InMemoryStoreRepository()
