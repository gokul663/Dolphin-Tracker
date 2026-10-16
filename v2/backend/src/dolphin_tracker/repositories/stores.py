"""Stop items (one per store, planning data + field progress) under the project's partition."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any, Protocol

from botocore.exceptions import ClientError

from dolphin_tracker.domain.errors import NotFoundError
from dolphin_tracker.domain.models import ROUTING_FIELDS, Page, Stop, now_iso
from dolphin_tracker.repositories.dynamo import (
    Keys,
    build_set_expression,
    decode_cursor,
    encode_cursor,
    from_ddb,
    strip_internal,
    to_ddb,
)

IMMUTABLE_STOP_FIELDS = {"uid"}
ROUTING_WRITE_WORKERS = 16

RoutingChange = tuple[str, dict[str, Any]]  # uid, {installer?, day?, seq?}


class StoreRepository(Protocol):
    def put_many(self, project_id: str, stops: list[Stop]) -> None: ...
    def get(self, project_id: str, stop_uid: str) -> Stop | None: ...
    def list(self, project_id: str, *, limit: int = 50, cursor: str | None = None) -> Page[Stop]: ...
    def list_all(self, project_id: str) -> list[Stop]:
        """Whole-project read for routing builds, the map pins endpoint and the routes bundle."""
        ...
    def update_fields(self, project_id: str, stop_uid: str, changes: dict[str, Any]) -> Stop:
        """Partial update; a dotted key (`fields.dma`) sets one entry of the `fields` map.

        Callers keep routing, progress and detail writes separate (AGENT-HANDOFF §2 rule 5).
        """
        ...
    def update_routing_many(self, project_id: str, changes: list[RoutingChange]) -> int:
        """Apply installer/day/seq diffs. Stops deleted meanwhile are skipped. Returns how many were written."""
        ...
    def delete_all(self, project_id: str) -> int: ...


def check_routing_change(changes: dict[str, Any]) -> None:
    extra = set(changes) - ROUTING_FIELDS
    if extra:
        raise ValueError(f"Routing writes may only touch installer/day/seq, got {sorted(extra)}")


class DynamoStoreRepository:
    def __init__(self, table) -> None:
        self._table = table

    @staticmethod
    def _to_item(project_id: str, stop: Stop) -> dict[str, Any]:
        return {**Keys.stop(project_id, stop.uid), "entity": "STOP", **to_ddb(stop.model_dump(mode="json"))}

    @staticmethod
    def _from_item(item: dict[str, Any]) -> Stop:
        return Stop.model_validate(from_ddb(strip_internal(item)))

    def put_many(self, project_id: str, stops: list[Stop]) -> None:
        # batch_writer sends 25 items per BatchWriteItem and resubmits UnprocessedItems itself.
        with self._table.batch_writer(overwrite_by_pkeys=["PK", "SK"]) as batch:
            for stop in stops:
                batch.put_item(Item=self._to_item(project_id, stop))

    def get(self, project_id: str, stop_uid: str) -> Stop | None:
        item = self._table.get_item(Key=Keys.stop(project_id, stop_uid)).get("Item")
        return self._from_item(item) if item else None

    def _query_kwargs(self, project_id: str) -> dict[str, Any]:
        return {
            "KeyConditionExpression": "PK = :pk AND begins_with(SK, :prefix)",
            "ExpressionAttributeValues": {":pk": Keys.project(project_id)["PK"], ":prefix": Keys.STOP_PREFIX},
        }

    def list(self, project_id: str, *, limit: int = 50, cursor: str | None = None) -> Page[Stop]:
        kwargs = {**self._query_kwargs(project_id), "Limit": limit}
        start_key = decode_cursor(cursor)
        if start_key:
            kwargs["ExclusiveStartKey"] = start_key
        response = self._table.query(**kwargs)
        items = [self._from_item(item) for item in response.get("Items", [])]
        return Page(items=items, next_cursor=encode_cursor(response.get("LastEvaluatedKey")))

    def _iter_items(self, project_id: str, **extra: Any):
        kwargs = {**self._query_kwargs(project_id), **extra}
        while True:
            response = self._table.query(**kwargs)
            yield from response.get("Items", [])
            last = response.get("LastEvaluatedKey")
            if not last:
                return
            kwargs["ExclusiveStartKey"] = last

    def list_all(self, project_id: str) -> list[Stop]:
        return [self._from_item(item) for item in self._iter_items(project_id)]

    def update_fields(self, project_id: str, stop_uid: str, changes: dict[str, Any]) -> Stop:
        payload = {key: value for key, value in changes.items() if key not in IMMUTABLE_STOP_FIELDS}
        payload["updated_at"] = now_iso()
        expression, names, values = build_set_expression(payload)
        try:
            response = self._table.update_item(
                Key=Keys.stop(project_id, stop_uid),
                UpdateExpression=expression,
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
                ConditionExpression="attribute_exists(PK)",
                ReturnValues="ALL_NEW",
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            raise NotFoundError(f"Stop {stop_uid} not found") from exc
        return self._from_item(response["Attributes"])

    def _write_routing(self, project_id: str, stop_uid: str, changes: dict[str, Any], updated_at: str) -> bool:
        # Clients are thread-safe, resource objects are not. The resource's client still applies boto3's
        # DynamoDB type transformation, so plain Python values go in here.
        expression, names, values = build_set_expression({**changes, "updated_at": updated_at})
        try:
            self._table.meta.client.update_item(
                TableName=self._table.name,
                Key=Keys.stop(project_id, stop_uid),
                UpdateExpression=expression,
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
                ConditionExpression="attribute_exists(PK)",
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return False
            raise
        return True

    def update_routing_many(self, project_id: str, changes: list[RoutingChange]) -> int:
        for _, change in changes:
            check_routing_change(change)
        if not changes:
            return 0
        updated_at = now_iso()
        with ThreadPoolExecutor(max_workers=ROUTING_WRITE_WORKERS) as pool:
            results = pool.map(
                lambda entry: self._write_routing(project_id, entry[0], entry[1], updated_at), changes
            )
            return sum(1 for written in results if written)

    def delete_all(self, project_id: str) -> int:
        keys = [
            {"PK": item["PK"], "SK": item["SK"]}
            for item in self._iter_items(project_id, ProjectionExpression="PK, SK")
        ]
        with self._table.batch_writer() as batch:
            for key in keys:
                batch.delete_item(Key=key)
        return len(keys)
