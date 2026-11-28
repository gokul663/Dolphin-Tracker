"""The device sync's review list: report records whose venue is not in the project, one item each under the
project's partition (`DEVREVIEW#<venue key>`), so a large PA never meets DynamoDB's item size limit.
Beside it, the screens of another PA at a store's address (`DEVOTHERPA#<key>`, rebuilt by each sync) and the ones
marked reviewed (`DEVPAOK#<situation>`, a bare marker kept for good).
StoreRepository.delete_all removes them with the project."""
from __future__ import annotations

from typing import Any, Protocol

from dolphin_tracker.domain.device import OtherPaScreen, ReviewItem
from dolphin_tracker.repositories.dynamo import Keys, from_ddb, strip_internal, to_ddb


class DeviceReviewRepository(Protocol):
    def list(self, project_id: str) -> list[ReviewItem]: ...
    def get(self, project_id: str, key: str) -> ReviewItem | None: ...
    def replace(self, project_id: str, items: list[ReviewItem]) -> int:
        """Make the list exactly `items`: writes new or changed items, deletes the rest. Returns the writes."""
        ...
    def put(self, project_id: str, item: ReviewItem) -> None: ...
    def delete(self, project_id: str, key: str) -> None: ...
    def list_other_pa(self, project_id: str) -> list[OtherPaScreen]: ...
    def get_other_pa(self, project_id: str, key: str) -> OtherPaScreen | None: ...
    def replace_other_pa(self, project_id: str, items: list[OtherPaScreen]) -> int: ...
    def delete_other_pa(self, project_id: str, key: str) -> None: ...
    def reviewed_other_pa(self, project_id: str) -> set[str]:
        """The situations marked "Reviewed, it's fine" (`domain/device_sync.other_pa_situation`)."""
        ...
    def mark_other_pa_reviewed(self, project_id: str, situation: str) -> None: ...


class DynamoDeviceReviewRepository:
    def __init__(self, table) -> None:
        self._table = table

    def _to_item(self, project_id: str, item: ReviewItem) -> dict[str, Any]:
        key = Keys.device_review(project_id, item.key)
        return {**key, "entity": "DEVREVIEW", **to_ddb(item.model_dump(mode="json"))}

    def _query(self, project_id: str, prefix: str, **extra: Any) -> list[dict[str, Any]]:
        kwargs: dict[str, Any] = {
            "KeyConditionExpression": "PK = :pk AND begins_with(SK, :prefix)",
            "ExpressionAttributeValues": {":pk": Keys.project(project_id)["PK"], ":prefix": prefix},
            **extra,
        }
        rows: list[dict[str, Any]] = []
        while True:
            response = self._table.query(**kwargs)
            rows.extend(response.get("Items", []))
            last = response.get("LastEvaluatedKey")
            if not last:
                return rows
            kwargs["ExclusiveStartKey"] = last

    def list(self, project_id: str) -> list[ReviewItem]:
        return [ReviewItem.model_validate(from_ddb(strip_internal(row)))
                for row in self._query(project_id, Keys.DEVICE_REVIEW_PREFIX)]

    def get(self, project_id: str, key: str) -> ReviewItem | None:
        row = self._table.get_item(Key=Keys.device_review(project_id, key)).get("Item")
        return ReviewItem.model_validate(from_ddb(strip_internal(row))) if row else None

    def replace(self, project_id: str, items: list[ReviewItem]) -> int:
        current = {item.key: item for item in self.list(project_id)}
        wanted = {item.key: item for item in items}
        writes = [item for key, item in wanted.items() if current.get(key) != item]
        gone = [key for key in current if key not in wanted]
        with self._table.batch_writer(overwrite_by_pkeys=["PK", "SK"]) as batch:
            for item in writes:
                batch.put_item(Item=self._to_item(project_id, item))
            for key in gone:
                batch.delete_item(Key=Keys.device_review(project_id, key))
        return len(writes) + len(gone)

    def put(self, project_id: str, item: ReviewItem) -> None:
        self._table.put_item(Item=self._to_item(project_id, item))

    def delete(self, project_id: str, key: str) -> None:
        self._table.delete_item(Key=Keys.device_review(project_id, key))

    # ---- screens of another PA at a store's address -------------------------------------------------------

    def list_other_pa(self, project_id: str) -> list[OtherPaScreen]:
        return [OtherPaScreen.model_validate(from_ddb(strip_internal(row)))
                for row in self._query(project_id, Keys.OTHER_PA_PREFIX)]

    def get_other_pa(self, project_id: str, key: str) -> OtherPaScreen | None:
        row = self._table.get_item(Key=Keys.other_pa(project_id, key)).get("Item")
        return OtherPaScreen.model_validate(from_ddb(strip_internal(row))) if row else None

    def replace_other_pa(self, project_id: str, items: list[OtherPaScreen]) -> int:
        current = {item.key: item for item in self.list_other_pa(project_id)}
        wanted = {item.key: item for item in items}
        writes = [item for key, item in wanted.items() if current.get(key) != item]
        gone = [key for key in current if key not in wanted]
        with self._table.batch_writer(overwrite_by_pkeys=["PK", "SK"]) as batch:
            for item in writes:
                batch.put_item(Item={**Keys.other_pa(project_id, item.key), "entity": "DEVOTHERPA",
                                     **to_ddb(item.model_dump(mode="json"))})
            for key in gone:
                batch.delete_item(Key=Keys.other_pa(project_id, key))
        return len(writes) + len(gone)

    def delete_other_pa(self, project_id: str, key: str) -> None:
        self._table.delete_item(Key=Keys.other_pa(project_id, key))

    def reviewed_other_pa(self, project_id: str) -> set[str]:
        prefix = Keys.OTHER_PA_REVIEWED_PREFIX
        rows = self._query(project_id, prefix, ProjectionExpression="SK")
        return {row["SK"][len(prefix):] for row in rows}

    def mark_other_pa_reviewed(self, project_id: str, situation: str) -> None:
        self._table.put_item(Item={**Keys.other_pa_reviewed(project_id, situation), "entity": "DEVPAOK"})
