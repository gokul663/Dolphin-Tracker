"""Lambda entry point for the device report: the only function that holds the Mongo secret.

Invoked synchronously by the API and the worker (`repositories/device_data.LambdaDeviceData`), never from the
internet. Events: {"op": "latest_date"} | {"op": "list_pas"} | {"op": "snapshot", "pa": "..."}.
Answers {"ok": true, ...} or {"ok": false, "error": "..."}.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Any

from aws_lambda_powertools import Logger

from dolphin_tracker.config import get_settings, resolve_mongo_uri
from dolphin_tracker.repositories.device_data import DeviceDataSource, DeviceDataUnavailable, MongoDeviceData

logger = Logger()


@lru_cache
def _source() -> MongoDeviceData:
    return MongoDeviceData(resolve_mongo_uri(get_settings()))  # one client per warm container


def dispatch(event: dict[str, Any], source: DeviceDataSource | None = None) -> dict[str, Any]:
    source = source or _source()
    op = event.get("op")
    try:
        if op == "latest_date":
            return {"ok": True, "date": source.latest_date()}
        if op == "list_pas":
            date, pas = source.list_pas()
            return {"ok": True, "date": date, "pas": pas}
        if op == "snapshot":
            pa = str(event.get("pa") or "").strip()
            if not pa:
                return {"ok": False, "error": "pa is required"}
            return {"ok": True, "snapshot": source.snapshot(pa).model_dump(mode="json")}
    except DeviceDataUnavailable as exc:
        logger.warning("Device report unavailable", extra={"op": op, "detail": str(exc)})
        return {"ok": False, "error": str(exc)}
    return {"ok": False, "error": f"unknown op {op!r}"}


@logger.inject_lambda_context(log_event=True)
def handler(event: dict[str, Any], context) -> dict[str, Any]:
    return dispatch(event)
