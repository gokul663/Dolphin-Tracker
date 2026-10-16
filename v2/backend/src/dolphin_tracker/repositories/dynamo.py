"""Single-table helpers: key builders, Decimal/float conversion, opaque pagination cursors, table access."""
from __future__ import annotations

import base64
import json
from decimal import Decimal
from typing import Any

import boto3
from botocore.config import Config

from dolphin_tracker.config import Settings

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


def encode_cursor(key: dict[str, Any] | None) -> str | None:
    if not key:
        return None
    payload = json.dumps(from_ddb(key), separators=(",", ":"), sort_keys=True).encode()
    return base64.urlsafe_b64encode(payload).decode().rstrip("=")


def decode_cursor(cursor: str | None) -> dict[str, Any] | None:
    if not cursor:
        return None
    padded = cursor + "=" * (-len(cursor) % 4)
    try:
        return to_ddb(json.loads(base64.urlsafe_b64decode(padded.encode())))
    except (ValueError, json.JSONDecodeError) as exc:
        raise ValueError("Invalid cursor") from exc


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
