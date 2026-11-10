"""The device sync's review list: report records whose venue is not in the project, one item each under the
project's partition (`DEVREVIEW#<venue key>`), so a large PA never meets DynamoDB's item size limit.
StoreRepository.delete_all removes them with the project."""
from __future__ import annotations

from typing import Any, Protocol

from dolphin_tracker.domain.device import ReviewItem
from dolphin_tracker.repositories.dynamo import Keys, from_ddb, strip_internal, to_ddb


class DeviceReviewRepository(Protocol):
    def list(self, project_id: str) -> list[ReviewItem]: ...
    def get(self, project_id: str, key: str) -> ReviewItem | None: ...
    def replace(self, project_id: str, items: list[ReviewItem]) -> int:
        """Make the list exactly `items`: writes new or changed items, deletes the rest. Returns the writes."""
        ...
    def put(self, project_id: str, item: ReviewItem) -> None: ...
    def delete(self, project_id: str, key: str) -> None: ...


class DynamoDeviceReviewRepository:
    def __init__(self, table) -> None:
        self._table = table

    def _to_item(self, project_id: str, item: ReviewItem) -> dict[str, Any]:
        key = Keys.device_review(project_id, item.key)
        return {**key, "entity": "DEVREVIEW", **to_ddb(item.model_dump(mode="json"))}

    def list(self, project_id: str) -> list[ReviewItem]:
        kwargs: dict[str, Any] = {
            "KeyConditionExpression": "PK = :pk AND begins_with(SK, :prefix)",
            "ExpressionAttributeValues": {
                ":pk": Keys.project(project_id)["PK"], ":prefix": Keys.DEVICE_REVIEW_PREFIX,
            },
        }
        items: list[ReviewItem] = []
        while True:
            response = self._table.query(**kwargs)
            items.extend(ReviewItem.model_validate(from_ddb(strip_internal(row))) for row in response.get("Items", []))
            last = response.get("LastEvaluatedKey")
            if not last:
                return items
            kwargs["ExclusiveStartKey"] = last

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
