"""Lambda entry point for the device report: the only function that holds the Mongo secret.

Invoked synchronously by the API and the worker (`repositories/device_data.LambdaDeviceData`), never from the
internet. Events: {"op": "latest_date"} | {"op": "list_pas"} | {"op": "snapshot", "pa": "..."} ("" = no PA) |
{"op": "logs", "codes": ["DD_...", ...]} |
{"op": "add_log", "log": {...}} (insert one Tracker log entry; the only write).
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
            if event.get("pa") is None:
                return {"ok": False, "error": "pa is required"}
            pa = str(event["pa"]).strip()  # "" = the venues with no PA
            return {"ok": True, "snapshot": source.snapshot(pa).model_dump(mode="json")}
        if op == "logs":
            codes = [str(code) for code in event.get("codes") or []]
            return {"ok": True, "logs": [log.model_dump(mode="json") for log in source.logs(codes)]}
        if op == "add_log":
            log = event.get("log")
            if not isinstance(log, dict) or not all(isinstance(value, str) for value in log.values()):
                return {"ok": False, "error": "log must be an object of text values"}
            return {"ok": True, "inserted": source.add_log(log)}
    except DeviceDataUnavailable as exc:
        logger.warning("Device report unavailable", extra={"op": op, "detail": str(exc)})
        return {"ok": False, "error": str(exc)}
    return {"ok": False, "error": f"unknown op {op!r}"}


@logger.inject_lambda_context  # the event itself is not logged: a log entry may carry a WiFi password
def handler(event: dict[str, Any], context) -> dict[str, Any]:
    logger.info("Device data call", extra={"op": event.get("op"), "pa": event.get("pa")})
    return dispatch(event)
