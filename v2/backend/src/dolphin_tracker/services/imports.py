"""Spreadsheet import job: read the upload, map known columns, verify every address with Google, store the result.

The result shape is AGENT-HANDOFF §3.4. Column-to-schema mapping happens in the review UI, so the job stays
schema-agnostic: `fields` carries the alias-mapped venue columns plus every unknown column, keyed by header.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any

from aws_lambda_powertools import Logger

from dolphin_tracker.domain.models import JobStatus
from dolphin_tracker.domain.parsing import (
    ADDRESS_ALIASES,
    DMA_ALIASES,
    PA_ALIASES,
    STATUS_ALIASES,
    STORE_ALIASES,
    VENUE_CODE_ALIASES,
    VENUE_TYPE_ALIASES,
    find_column,
    normalize_status,
    read_table,
)
from dolphin_tracker.repositories.files import FileStore, result_key
from dolphin_tracker.repositories.jobs import JobRepository
from dolphin_tracker.services.geocoding import Geocoder

logger = Logger(child=True)

CORE_ALIASES = (
    ADDRESS_ALIASES
    | STORE_ALIASES
    | PA_ALIASES
    | STATUS_ALIASES
    | VENUE_TYPE_ALIASES
    | DMA_ALIASES
    | VENUE_CODE_ALIASES
)
GEOCODE_WORKERS = 8
PROGRESS_EVERY = 10
MAX_IMPORT_ROWS = 5000


@dataclass
class ParsedRow:
    index: int
    address: str
    store_name: str = ""
    pa: str = ""
    status: str = "Incomplete"
    status_valid: bool = True
    status_raw: str = ""
    venue_type: str = ""
    dma: str = ""
    venue_code: str = ""
    extra: dict[str, str] = field(default_factory=dict)  # columns outside the known aliases, keyed by header


@dataclass
class ParsedTable:
    rows: list[ParsedRow]
    columns: list[str]
    address_column: str
    store_column: str | None
    extra_columns: list[str]
    venue_columns: list[str] = field(default_factory=list)  # which of venue_type/dma/venue_code the sheet has

    @property
    def pa_names(self) -> list[str]:
        return sorted({row.pa for row in self.rows if row.pa})


def verify_row(row: ParsedRow, geocoder: Geocoder) -> dict[str, Any]:
    """Apply v1's status rules to one row. The route address always comes from geocoding, never from Places."""
    fields: dict[str, Any] = {key: getattr(row, key) for key in ("venue_type", "dma", "venue_code")}
    result: dict[str, Any] = {
        "index": row.index,
        "address": row.address,
        "store_name": row.store_name,
        "pa": row.pa,
        "status": "invalid",
        "confidence": 0,
        "verified_by": [],
        "formatted": "",
        "addr": "",
        "city": "",
        "state": "",
        "zip": "",
        "lat": None,
        "lng": None,
        "place_name": "",
        "suggestions": [],
        "error": "",
        "venue_status": row.status,
        "venue_status_valid": row.status_valid,
        "venue_status_raw": row.status_raw,
        "fields": {**fields, **row.extra},
    }
    address = row.address.strip()
    if not address:
        result["error"] = "Missing address"
        return result

    geo = geocoder.geocode(address)
    place = geocoder.find_place(f"{row.store_name}, {address}" if row.store_name else address)
    result["verified_by"] = [name for name, hit in (("geocoding", geo), ("places", place)) if hit.get("ok")]

    if geo.get("ok"):
        result.update(
            formatted=geo.get("formatted", ""),
            addr=geo.get("addr") or address,
            city=geo.get("city", ""),
            state=geo.get("state", ""),
            zip=geo.get("zip", ""),
            lat=geo.get("lat"),
            lng=geo.get("lng"),
            suggestions=geo.get("suggestions", []),
            place_name=(place.get("name") or "") if place.get("ok") else "",
        )
        if geo.get("partial"):
            result.update(status="needs_review", confidence=40, error="Partial match — please review")
        else:
            result.update(status="valid", confidence=100 if place.get("ok") else 70)
        return result

    result.update(
        status="needs_review",
        confidence=0,
        suggestions=geo.get("suggestions") or geocoder.autocomplete(address),
        error=geo.get("error") or "Could not geocode address",
    )
    return result


class ImportService:
    def __init__(
        self, jobs: JobRepository | None = None, files: FileStore | None = None, geocoder: Geocoder | None = None
    ) -> None:
        self._jobs = jobs
        self._files = files
        self._geocoder = geocoder

    @staticmethod
    def parse(filename: str, raw: bytes) -> ParsedTable:
        """Read the sheet and map known columns. Raises ValueError when there is no address column."""
        table = read_table(filename, raw)
        columns = list(table[0].keys()) if table else []
        address_column = find_column(columns, ADDRESS_ALIASES)
        if not address_column:
            raise ValueError("Missing 'address' column")
        store_column = find_column(columns, STORE_ALIASES)
        pa_column = find_column(columns, PA_ALIASES)
        status_column = find_column(columns, STATUS_ALIASES)
        venue = {
            "venue_type": find_column(columns, VENUE_TYPE_ALIASES),
            "dma": find_column(columns, DMA_ALIASES),
            "venue_code": find_column(columns, VENUE_CODE_ALIASES),
        }
        extra_columns = [column for column in columns if column not in CORE_ALIASES]

        rows: list[ParsedRow] = []
        for index, record in enumerate(table):
            status_raw = record.get(status_column, "") if status_column else ""
            status, status_valid = normalize_status(status_raw) if status_column else ("Incomplete", True)
            rows.append(
                ParsedRow(
                    index=index,
                    address=record.get(address_column, ""),
                    store_name=record.get(store_column, "") if store_column else "",
                    pa=record.get(pa_column, "") if pa_column else "",
                    status=status,
                    status_valid=status_valid,
                    status_raw=status_raw,
                    venue_type=record.get(venue["venue_type"], "") if venue["venue_type"] else "",
                    dma=record.get(venue["dma"], "") if venue["dma"] else "",
                    venue_code=record.get(venue["venue_code"], "") if venue["venue_code"] else "",
                    extra={column: record.get(column, "") for column in extra_columns},
                )
            )
        return ParsedTable(
            rows=rows,
            columns=columns,
            address_column=address_column,
            store_column=store_column,
            extra_columns=extra_columns,
            venue_columns=[key for key, column in venue.items() if column],
        )

    @staticmethod
    def build_result(table: ParsedTable, verified: list[dict[str, Any]]) -> dict[str, Any]:
        rows = sorted(verified, key=lambda row: row["index"])
        for row in rows:  # only venue columns the sheet actually has
            for key in ("venue_type", "dma", "venue_code"):
                if key not in table.venue_columns:
                    row["fields"].pop(key, None)
        counts = {
            status: sum(1 for row in rows if row["status"] == status) for status in ("valid", "needs_review", "invalid")
        }
        return {
            "columns": table.columns,
            "address_column": table.address_column,
            "store_column": table.store_column,
            "extra_columns": table.extra_columns,
            "summary": {"total": len(rows), **counts},
            "pa_names": table.pa_names,
            "rows": rows,
        }

    def run(self, job_id: str, event: dict[str, Any]) -> None:
        """Worker entry point for an import_parse job. Every failure ends as a `failed` job with a message."""
        assert self._jobs is not None and self._files is not None and self._geocoder is not None
        try:
            job = self._jobs.get(job_id)
            if job is None:
                logger.warning("Import job vanished before it ran", extra={"job_id": job_id})
                return
            if job.status in (JobStatus.SUCCEEDED, JobStatus.FAILED):  # at-least-once delivery: already done
                logger.info("Import job already finished; ignoring redelivery", extra={"job_id": job_id})
                return
            self._jobs.set_status(job_id, JobStatus.RUNNING, progress=1, message="Reading file")
            raw = self._files.get_bytes(job.payload["upload_key"])
            table = self.parse(job.payload.get("filename") or job.payload["upload_key"], raw)
            total = len(table.rows)
            if total > MAX_IMPORT_ROWS:
                raise ValueError(f"The sheet has {total} rows; the limit is {MAX_IMPORT_ROWS}")
            self._jobs.set_status(job_id, JobStatus.RUNNING, progress=5, message=f"Verifying 0/{total} addresses")

            verified: list[dict[str, Any]] = []
            with ThreadPoolExecutor(max_workers=GEOCODE_WORKERS) as pool:
                futures = [pool.submit(verify_row, row, self._geocoder) for row in table.rows]
                for done, future in enumerate(as_completed(futures), start=1):
                    verified.append(future.result())
                    if done % PROGRESS_EVERY == 0 and done < total:
                        self._jobs.set_status(
                            job_id,
                            JobStatus.RUNNING,
                            progress=5 + (90 * done) // total,
                            message=f"Verifying {done}/{total} addresses",
                        )

            result = self.build_result(table, verified)
            key = result_key(job_id)
            self._files.put_json(key, result)
            summary = result["summary"]
            self._jobs.set_result(
                job_id,
                key,
                message=f"{summary['valid']} valid, {summary['needs_review']} to review, {summary['invalid']} invalid",
            )
            logger.info("Import finished", extra={"job_id": job_id, **summary})
        except Exception as exc:
            logger.exception("Import failed", extra={"job_id": job_id})
            message = str(exc) if isinstance(exc, (ValueError, KeyError)) else f"Import failed: {exc}"
            try:
                self._jobs.set_status(job_id, JobStatus.FAILED, message=message)
            except Exception:
                logger.exception("Could not mark import job failed", extra={"job_id": job_id})
