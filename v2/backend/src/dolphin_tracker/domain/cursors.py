"""Opaque pagination cursors: URL-safe base64 of a JSON object, padding stripped. Pure (no boto3), so services that
page in memory and the DynamoDB repositories share one encoding."""
from __future__ import annotations

import base64
import json
from decimal import Decimal
from typing import Any


def _plain(value: Any) -> Any:
    # DynamoDB hands back Decimals inside LastEvaluatedKey; JSON has no Decimal.
    if isinstance(value, Decimal):
        return int(value) if value % 1 == 0 else float(value)
    raise TypeError(f"Cannot encode {type(value).__name__} in a cursor")


def encode_cursor(key: dict[str, Any] | None) -> str | None:
    if not key:
        return None
    payload = json.dumps(key, separators=(",", ":"), sort_keys=True, default=_plain).encode()
    return base64.urlsafe_b64encode(payload).decode().rstrip("=")


def decode_cursor(cursor: str | None) -> dict[str, Any] | None:
    """The JSON object in `cursor`, or None for no cursor. ValueError for anything we could not have issued."""
    if not cursor:
        return None
    padded = cursor + "=" * (-len(cursor) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(padded.encode()))
    except (ValueError, json.JSONDecodeError) as exc:
        raise ValueError("Invalid cursor") from exc
    if not isinstance(payload, dict):  # decodable but not a key we issued (a list, string, number)
        raise ValueError("Invalid cursor")
    return payload


def offset_from_cursor(cursor: str | None) -> int:
    """The offset in an `{"offset": n}` cursor (services that page in memory). Anything else is a bad cursor."""
    offset = (decode_cursor(cursor) or {}).get("offset", 0)
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise ValueError("Invalid cursor")
    return offset
