"""Project META items. Fully implemented as the reference for the other repositories."""
from __future__ import annotations

from typing import Any, Protocol

from botocore.exceptions import ClientError

from dolphin_tracker.domain.errors import ConflictError, NotFoundError
from dolphin_tracker.domain.models import Page, Project, now_iso
from dolphin_tracker.repositories.dynamo import (
    GSI1,
    PROJECT_LIST_GSI1PK,
    Keys,
    decode_cursor,
    encode_cursor,
    from_ddb,
    strip_internal,
    to_ddb,
)

IMMUTABLE_FIELDS = {"id", "version", "created_at"}


class ProjectRepository(Protocol):
    def put(self, project: Project) -> None: ...
    def get(self, project_id: str) -> Project | None: ...
    def list(self, *, limit: int = 50, cursor: str | None = None) -> Page[Project]: ...
    def update(self, project_id: str, changes: dict[str, Any], *, expected_version: int | None = None) -> Project: ...
    def delete(self, project_id: str) -> None: ...


class DynamoProjectRepository:
    def __init__(self, table) -> None:
        self._table = table

    @staticmethod
    def _to_item(project: Project) -> dict[str, Any]:
        return {
            **Keys.project(project.id),
            "entity": "PROJECT",
            "GSI1PK": PROJECT_LIST_GSI1PK,
            "GSI1SK": project.created_at,
            **to_ddb(project.model_dump(mode="json")),
        }

    @staticmethod
    def _from_item(item: dict[str, Any]) -> Project:
        return Project.model_validate(from_ddb(strip_internal(item)))

    def put(self, project: Project) -> None:
        self._table.put_item(Item=self._to_item(project))

    def get(self, project_id: str) -> Project | None:
        response = self._table.get_item(Key=Keys.project(project_id))
        item = response.get("Item")
        return self._from_item(item) if item else None

    def list(self, *, limit: int = 50, cursor: str | None = None) -> Page[Project]:
        kwargs: dict[str, Any] = {
            "IndexName": GSI1,
            "KeyConditionExpression": "GSI1PK = :pk",
            "ExpressionAttributeValues": {":pk": PROJECT_LIST_GSI1PK},
            "ScanIndexForward": False,  # newest first
            "Limit": limit,
        }
        start_key = decode_cursor(cursor)
        if start_key:
            kwargs["ExclusiveStartKey"] = start_key
        response = self._table.query(**kwargs)
        items = [self._from_item(item) for item in response.get("Items", [])]
        return Page(items=items, next_cursor=encode_cursor(response.get("LastEvaluatedKey")))

    def update(self, project_id: str, changes: dict[str, Any], *, expected_version: int | None = None) -> Project:
        payload = {key: value for key, value in changes.items() if key not in IMMUTABLE_FIELDS}
        payload["updated_at"] = now_iso()
        names = {f"#f{index}": key for index, key in enumerate(payload)}
        values = {f":v{index}": to_ddb(value) for index, value in enumerate(payload.values())}
        assignments = ", ".join(f"{name} = {value}" for name, value in zip(names, values, strict=True))
        names["#version"] = "version"
        values[":one"] = 1
        condition = "attribute_exists(PK)"
        if expected_version is not None:
            condition += " AND #version = :expected"
            values[":expected"] = expected_version
        try:
            response = self._table.update_item(
                Key=Keys.project(project_id),
                UpdateExpression=f"SET {assignments}, #version = #version + :one",
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
                ConditionExpression=condition,
                ReturnValues="ALL_NEW",
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            if self.get(project_id) is None:
                raise NotFoundError(f"Project {project_id} not found") from exc
            raise ConflictError(f"Project {project_id} was modified concurrently") from exc
        return self._from_item(response["Attributes"])

    def delete(self, project_id: str) -> None:
        # Stops under the same PK are removed by StoreRepository.delete_all(project_id); callers do both.
        self._table.delete_item(Key=Keys.project(project_id))
