"""Pick lists (ROUTE-PLANNER §2): one item per installer / manager name, and the category tree as one item."""
from __future__ import annotations

from typing import Any, Protocol

from botocore.exceptions import ClientError

from dolphin_tracker.domain.cursors import encode_cursor
from dolphin_tracker.domain.lists import Category, NameEntry, NameListKind, name_key
from dolphin_tracker.domain.models import Page, now_iso
from dolphin_tracker.repositories.dynamo import Keys, from_ddb, query_page, to_ddb


class ListRepository(Protocol):
    def list_names(self, kind: NameListKind, *, limit: int = 200, cursor: str | None = None) -> Page[NameEntry]:
        """Alphabetical (case-insensitive)."""
        ...
    def add_name(self, kind: NameListKind, value: str) -> NameEntry:
        """Idempotent: a name already listed (ignoring case and spacing) returns the stored entry."""
        ...
    def delete_name(self, kind: NameListKind, value: str) -> None: ...
    def get_categories(self) -> list[Category] | None:
        """None until someone saves a tree; the service then serves the defaults."""
        ...
    def put_categories(self, categories: list[Category]) -> None: ...


class DynamoListRepository:
    def __init__(self, table) -> None:
        self._table = table

    def list_names(self, kind: NameListKind, *, limit: int = 200, cursor: str | None = None) -> Page[NameEntry]:
        kwargs: dict[str, Any] = {
            "KeyConditionExpression": "PK = :pk AND begins_with(SK, :prefix)",
            "ExpressionAttributeValues": {":pk": Keys.name_list(kind.value), ":prefix": "ITEM#"},
            "Limit": limit,
        }
        response = query_page(self._table, kwargs, cursor)
        items = [NameEntry(value=item["value"], created_at=item.get("created_at", "")) for item in response["Items"]]
        return Page(items=items, next_cursor=encode_cursor(response.get("LastEvaluatedKey")))

    def add_name(self, kind: NameListKind, value: str) -> NameEntry:
        entry = NameEntry(value=value, created_at=now_iso())
        key = Keys.name_entry(kind.value, name_key(value))
        try:
            self._table.put_item(
                Item={**key, "entity": "LIST_ITEM", **entry.model_dump()},
                ConditionExpression="attribute_not_exists(PK)",
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            item = self._table.get_item(Key=key)["Item"]
            return NameEntry(value=item["value"], created_at=item.get("created_at", ""))
        return entry

    def delete_name(self, kind: NameListKind, value: str) -> None:
        self._table.delete_item(Key=Keys.name_entry(kind.value, name_key(value)))

    def get_categories(self) -> list[Category] | None:
        item = self._table.get_item(Key=Keys.categories()).get("Item")
        if not item:
            return None
        return [Category.model_validate(entry) for entry in from_ddb(item["categories"])]

    def put_categories(self, categories: list[Category]) -> None:
        self._table.put_item(
            Item={
                **Keys.categories(),
                "entity": "CATEGORIES",
                "categories": to_ddb([category.model_dump() for category in categories]),
                "updated_at": now_iso(),
            }
        )
