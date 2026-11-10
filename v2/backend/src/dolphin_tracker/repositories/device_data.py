"""Read the CMS device report (MongoDB `dolphin_venue_vision.dolphin-internal-report`, one row per venue per day).

Only the device-data Lambda (`handlers/device_data.py`) holds the Mongo secret and talks to Mongo; the API and the
worker reach it through `LambdaDeviceData`. Locally, with DT_MONGO_URI set, `MongoDeviceData` runs in-process.
Read-only: nothing here writes to Mongo.
"""
from __future__ import annotations

import json
from typing import Any, Protocol

from dolphin_tracker.config import Settings, resolve_mongo_uri
from dolphin_tracker.domain.device import DeviceRecord, DeviceSnapshot, report_date_iso, utc_iso

DATABASE = "dolphin_venue_vision"
COLLECTION = "dolphin-internal-report"
FIELDS = (
    "Venue ID", "Date", "Status", "Last Seen (UTC)", "Offline Days", "Serial Number", "Venue Name", "Store Name",
    "Address", "City", "State", "State Code", "Zip Code", "Latitude", "Longitude", "PA Name", "PK External ID",
    "ingested_at_utc",
)
QUERY_MS = 20_000


class DeviceDataUnavailable(RuntimeError):
    """The report could not be read (not configured, Mongo unreachable, the Lambda failed)."""


class DeviceDataSource(Protocol):
    def latest_date(self) -> str:
        """The report's newest day, YYYY-MM-DD."""
        ...
    def list_pas(self) -> tuple[str, list[str]]:
        """(newest day, the PA names in it, sorted)."""
        ...
    def snapshot(self, pa: str) -> DeviceSnapshot:
        """Every record of `pa` for the newest day."""
        ...


class MongoDeviceData:
    def __init__(self, uri: str, *, client: Any = None) -> None:
        self._uri = uri
        self._client = client

    def _collection(self):
        if self._client is None:
            if not self._uri:
                raise DeviceDataUnavailable("No MongoDB connection string (DT_MONGO_URI / DT_MONGO_URI_SECRET)")
            from pymongo import MongoClient  # local import: only this adapter needs pymongo

            self._client = MongoClient(
                self._uri, serverSelectionTimeoutMS=8000, connectTimeoutMS=8000, socketTimeoutMS=30000,
                appname="dolphin-tracker", readPreference="secondaryPreferred",
            )
        return self._client[DATABASE][COLLECTION]

    def _newest_raw_date(self) -> tuple[str, str]:
        """(the stored MM-DD-YYYY text, its ISO date). `Date` is text, so the newest is found by parsing every
        distinct value (a few hundred, from the Date index), never by sorting the 1.6M rows."""
        try:
            values = self._collection().distinct("Date", maxTimeMS=QUERY_MS)
        except Exception as exc:  # pymongo errors carry host names, never the password
            raise DeviceDataUnavailable(f"Device report unreachable: {type(exc).__name__}") from exc
        dated = [(iso, raw) for raw in values if (iso := report_date_iso(raw))]
        if not dated:
            raise DeviceDataUnavailable("The device report has no dated rows")
        iso, raw = max(dated)
        return raw, iso

    def latest_date(self) -> str:
        return self._newest_raw_date()[1]

    def list_pas(self) -> tuple[str, list[str]]:
        raw, iso = self._newest_raw_date()
        try:
            names = self._collection().distinct("PA Name", {"Date": raw}, maxTimeMS=QUERY_MS)
        except Exception as exc:
            raise DeviceDataUnavailable(f"Device report unreachable: {type(exc).__name__}") from exc
        return iso, sorted({str(name).strip() for name in names if name and str(name).strip()}, key=str.lower)

    def snapshot(self, pa: str) -> DeviceSnapshot:
        raw, iso = self._newest_raw_date()
        try:
            docs = list(
                self._collection()
                .find({"Date": raw, "PA Name": pa}, dict.fromkeys(FIELDS, 1) | {"_id": 0})
                .max_time_ms(QUERY_MS)
            )
        except Exception as exc:
            raise DeviceDataUnavailable(f"Device report unreachable: {type(exc).__name__}") from exc
        ingested = max((utc_iso(doc.get("ingested_at_utc")) for doc in docs), default="")
        records = [DeviceRecord.from_report(doc) for doc in docs if doc.get("Venue ID")]
        return DeviceSnapshot(pa=pa, date=iso, ingested_at=ingested, records=records)


class LambdaDeviceData:
    """Calls the device-data Lambda synchronously (RequestResponse); same answers as MongoDeviceData."""

    def __init__(self, function_name: str, *, region: str = "us-east-1", client: Any = None) -> None:
        self._function_name = function_name
        self._region = region
        self._client = client

    def _call(self, event: dict[str, Any]) -> dict[str, Any]:
        if self._client is None:
            import boto3  # local import: tests and local runs never need it

            self._client = boto3.client("lambda", region_name=self._region)
        response = self._client.invoke(
            FunctionName=self._function_name, InvocationType="RequestResponse", Payload=json.dumps(event).encode()
        )
        body = json.loads(response["Payload"].read() or b"{}")
        if response.get("FunctionError") or not body.get("ok"):
            raise DeviceDataUnavailable(body.get("error") or body.get("errorMessage") or "Device data Lambda failed")
        return body

    def latest_date(self) -> str:
        return self._call({"op": "latest_date"})["date"]

    def list_pas(self) -> tuple[str, list[str]]:
        body = self._call({"op": "list_pas"})
        return body["date"], body["pas"]

    def snapshot(self, pa: str) -> DeviceSnapshot:
        return DeviceSnapshot.model_validate(self._call({"op": "snapshot", "pa": pa})["snapshot"])


def make_device_data(settings: Settings) -> DeviceDataSource | None:
    """The Lambda in AWS, Mongo directly when a connection string is configured (local), else None (no sync)."""
    if settings.device_data_function_name:
        return LambdaDeviceData(settings.device_data_function_name, region=settings.aws_region)
    if settings.mongo_uri or settings.mongo_uri_secret:
        return MongoDeviceData(resolve_mongo_uri(settings))
    return None
