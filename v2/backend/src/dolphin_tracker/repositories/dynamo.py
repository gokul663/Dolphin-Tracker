"""Single-table helpers: key builders, Decimal/float conversion, cursor-driven queries, table access."""
from __future__ import annotations

from decimal import Decimal
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from dolphin_tracker.config import Settings
from dolphin_tracker.domain.cursors import decode_cursor

PROJECT_LIST_GSI1PK = "PROJECT"
GSI1 = "GSI1"
INTERNAL_ATTRIBUTES = {"PK", "SK", "GSI1PK", "GSI1SK", "entity"}


class Keys:
    STOP_PREFIX = "STOP#"

    @staticmethod
    def project(project_id: str) -> dict[str, str]:
        return {"PK": f"PROJECT#{project_id}", "SK": "META"}

    @staticmethod
    def stop(project_id: str, stop_uid: str) -> dict[str, str]:
        return {"PK": f"PROJECT#{project_id}", "SK": f"{Keys.STOP_PREFIX}{stop_uid}"}

    @staticmethod
    def job(job_id: str) -> dict[str, str]:
        return {"PK": f"JOB#{job_id}", "SK": "META"}


def to_ddb(value: Any) -> Any:
    """Convert floats to Decimal (boto3 rejects float) recursively; leave everything else alone."""
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {key: to_ddb(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_ddb(item) for item in value]
    return value


def from_ddb(value: Any) -> Any:
    """Convert Decimals back to int or float recursively."""
    if isinstance(value, Decimal):
        return int(value) if value % 1 == 0 else float(value)
    if isinstance(value, dict):
        return {key: from_ddb(item) for key, item in value.items()}
    if isinstance(value, list):
        return [from_ddb(item) for item in value]
    return value


TABLE_KEY = frozenset({"PK", "SK"})
GSI1_KEY = TABLE_KEY | {"GSI1PK", "GSI1SK"}


def query_page(
    table: Any, kwargs: dict[str, Any], cursor: str | None, key_attributes: frozenset[str] = TABLE_KEY
) -> dict[str, Any]:
    """Run a Query starting after `cursor`. A start key that is not this query's key shape is a bad cursor (400),
    never a botocore error (500). DynamoDB's own ValidationException is mapped the same way as a backstop."""
    start_key = decode_cursor(cursor)
    if start_key:
        if set(start_key) != key_attributes or not all(isinstance(value, str) for value in start_key.values()):
            raise ValueError("Invalid cursor")
        kwargs = {**kwargs, "ExclusiveStartKey": to_ddb(start_key)}
    try:
        return table.query(**kwargs)
    except ClientError as exc:
        if start_key and exc.response.get("Error", {}).get("Code") == "ValidationException":
            raise ValueError("Invalid cursor") from exc
        raise


def build_set_expression(changes: dict[str, Any]) -> tuple[str, dict[str, str], dict[str, Any]]:
    """`SET` expression, names and values for a partial update. A dotted key (`fields.dma`) sets one nested map entry.

    Every path segment goes through ExpressionAttributeNames, so reserved words and odd keys are safe.
    """
    names: dict[str, str] = {}
    values: dict[str, Any] = {}
    assignments: list[str] = []
    for index, (key, value) in enumerate(changes.items()):
        segments = []
        for depth, segment in enumerate(key.split(".")):
            name = f"#f{index}_{depth}"
            names[name] = segment
            segments.append(name)
        values[f":v{index}"] = to_ddb(value)
        assignments.append(f"{'.'.join(segments)} = :v{index}")
    return "SET " + ", ".join(assignments), names, values


def strip_internal(item: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in item.items() if key not in INTERNAL_ATTRIBUTES}


def dynamodb_resource(settings: Settings, *, quick: bool = False):
    config = Config(connect_timeout=1, read_timeout=2, retries={"max_attempts": 1}) if quick else None
    return boto3.resource(
        "dynamodb",
        region_name=settings.aws_region,
        endpoint_url=settings.dynamodb_endpoint_url or None,
        config=config,
    )


def get_table(settings: Settings):
    return dynamodb_resource(settings).Table(settings.table_name)


TABLE_DEFINITION: dict[str, Any] = {
    "KeySchema": [
        {"AttributeName": "PK", "KeyType": "HASH"},
        {"AttributeName": "SK", "KeyType": "RANGE"},
    ],
    "AttributeDefinitions": [
        {"AttributeName": "PK", "AttributeType": "S"},
        {"AttributeName": "SK", "AttributeType": "S"},
        {"AttributeName": "GSI1PK", "AttributeType": "S"},
        {"AttributeName": "GSI1SK", "AttributeType": "S"},
    ],
    "GlobalSecondaryIndexes": [
        {
            "IndexName": GSI1,
            "KeySchema": [
                {"AttributeName": "GSI1PK", "KeyType": "HASH"},
                {"AttributeName": "GSI1SK", "KeyType": "RANGE"},
            ],
            "Projection": {"ProjectionType": "ALL"},
        }
    ],
    "BillingMode": "PAY_PER_REQUEST",
}
"""Mirror of infra/stacks/data_stack.py for DynamoDB Local and moto tests."""
