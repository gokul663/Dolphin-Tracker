"""Pick lists (ROUTE-PLANNER §2): one item per installer / manager name, and the category tree as one item."""
from __future__ import annotations

import uuid
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
    def save_entry(self, kind: NameListKind, entry: NameEntry, *, must_be_new: bool = False) -> NameEntry | None:
        """Write the entry with its details, over the one of the same name (its created_at is kept). With
        `must_be_new`, None when the name is already listed and nothing is written."""
        ...
    def get_entry(self, kind: NameListKind, value: str) -> NameEntry | None:
        """The entry of this name (ignoring case and spacing), if listed."""
        ...
    def delete_name(self, kind: NameListKind, value: str) -> None: ...
    def get_categories(self) -> list[Category] | None:
        """None until someone saves a tree; the service then serves the defaults."""
        ...
    def put_categories(self, categories: list[Category]) -> None: ...


def _entry(item: dict[str, Any]) -> NameEntry:
    return NameEntry(**{name: item[name] for name in NameEntry.model_fields if name in item})


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
        items = [_entry(item) for item in response["Items"]]
        return Page(items=items, next_cursor=encode_cursor(response.get("LastEvaluatedKey")))

    def add_name(self, kind: NameListKind, value: str) -> NameEntry:
        entry = NameEntry(id=uuid.uuid4().hex, value=value, created_at=now_iso())
        key = Keys.name_entry(kind.value, name_key(value))
        try:
            self._table.put_item(
                Item={**key, "entity": "LIST_ITEM", **entry.model_dump()},
                ConditionExpression="attribute_not_exists(PK)",
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            return _entry(self._table.get_item(Key=key)["Item"])
        return entry

    def save_entry(self, kind: NameListKind, entry: NameEntry, *, must_be_new: bool = False) -> NameEntry | None:
        key = Keys.name_entry(kind.value, name_key(entry.value))
        existing = self._table.get_item(Key=key).get("Item")
        if existing and must_be_new:
            return None
        saved = entry.model_copy(update={
            "id": entry.id or (existing or {}).get("id") or uuid.uuid4().hex,
            "created_at": entry.created_at or (existing or {}).get("created_at") or now_iso(),
        })
        self._table.put_item(Item={**key, "entity": "LIST_ITEM", **saved.model_dump()})
        return saved

    def get_entry(self, kind: NameListKind, value: str) -> NameEntry | None:
        item = self._table.get_item(Key=Keys.name_entry(kind.value, name_key(value))).get("Item")
        return _entry(item) if item else None

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
