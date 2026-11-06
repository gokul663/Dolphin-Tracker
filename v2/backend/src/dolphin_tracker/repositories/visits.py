"""Visit items (ROUTE-PLANNER §7): `PROJECT#<id>` / `VISIT#<uid>#<created_at>#<id>`, plus the store's per-stick
summary (`screen_visits`, `last_visit_at`) written in the same transaction."""
from __future__ import annotations

from typing import Any, Protocol

from botocore.exceptions import ClientError

from dolphin_tracker.domain.cursors import encode_cursor
from dolphin_tracker.domain.errors import NotFoundError
from dolphin_tracker.domain.models import Page
from dolphin_tracker.domain.visits import Visit
from dolphin_tracker.repositories.dynamo import Keys, from_ddb, query_page, strip_internal, to_ddb


class VisitRepository(Protocol):
    def add(self, visit: Visit) -> Visit:
        """Write the visit and set `screen_visits[<screen>]` and `last_visit_at` on its store to `created_at`.
        NotFoundError if the store is gone."""
        ...
    def list_for_store(
        self, project_id: str, stop_uid: str, *, limit: int = 50, cursor: str | None = None
    ) -> Page[Visit]:
        """Newest first."""
        ...


class DynamoVisitRepository:
    def __init__(self, table) -> None:
        self._table = table

    def add(self, visit: Visit) -> Visit:
        stop_key = Keys.stop(visit.project_id, visit.stop_uid)
        try:
            # Stores written before visits existed have no map; a nested SET needs the parent to exist.
            self._table.update_item(
                Key=stop_key,
                UpdateExpression="SET screen_visits = if_not_exists(screen_visits, :empty)",
                ConditionExpression="attribute_exists(PK)",
                ExpressionAttributeValues={":empty": {}},
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            raise NotFoundError(f"Stop {visit.stop_uid} not found") from exc
        item = {
            **Keys.visit(visit.project_id, visit.stop_uid, visit.created_at, visit.id),
            "entity": "VISIT",
            **to_ddb(visit.model_dump(mode="json")),
        }
        client = self._table.meta.client
        try:
            client.transact_write_items(TransactItems=[
                {"Put": {"TableName": self._table.name, "Item": item,
                         "ConditionExpression": "attribute_not_exists(PK)"}},
                {"Update": {
                    "TableName": self._table.name,
                    "Key": stop_key,
                    # `created_at` is when the visit was logged (not its visit date), so the newest write is latest.
                    "UpdateExpression": "SET screen_visits.#screen = :at, last_visit_at = :at",
                    "ConditionExpression": "attribute_exists(PK)",
                    "ExpressionAttributeNames": {"#screen": visit.screen_id},
                    "ExpressionAttributeValues": {":at": visit.created_at},
                }},
            ])
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "TransactionCanceledException":
                raise
            raise NotFoundError(f"Stop {visit.stop_uid} not found") from exc
        return visit

    def list_for_store(
        self, project_id: str, stop_uid: str, *, limit: int = 50, cursor: str | None = None
    ) -> Page[Visit]:
        kwargs: dict[str, Any] = {
            "KeyConditionExpression": "PK = :pk AND begins_with(SK, :prefix)",
            "ExpressionAttributeValues": {
                ":pk": Keys.project(project_id)["PK"], ":prefix": Keys.visit_prefix(stop_uid),
            },
            "ScanIndexForward": False,
            "Limit": limit,
        }
        response = query_page(self._table, kwargs, cursor)
        items = [Visit.model_validate(from_ddb(strip_internal(item))) for item in response.get("Items", [])]
        return Page(items=items, next_cursor=encode_cursor(response.get("LastEvaluatedKey")))
