"""Spreadsheet import job: read the upload, map columns to store fields (STORE-MODEL §6), verify every address
with Google, flag duplicates within the sheet, store the result.

The result shape is `api.schemas.ImportResult`. The mapping used is part of the result; for an append it starts
from the project's saved `import_mappings`, so a second sheet of the same shape maps the same way.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Any

from aws_lambda_powertools import Logger

from dolphin_tracker.domain.import_mapping import (
    FIELDS,
    MappedRow,
    detect_mapping,
    geocode_query,
    map_row,
    mark_duplicates,
)
from dolphin_tracker.domain.models import JobStatus
from dolphin_tracker.domain.parsing import read_table
from dolphin_tracker.repositories.files import FileStore, result_key
from dolphin_tracker.repositories.jobs import JobRepository
from dolphin_tracker.repositories.projects import ProjectRepository
from dolphin_tracker.services.geocoding import Geocoder

logger = Logger(child=True)

GEOCODE_WORKERS = 8
PROGRESS_EVERY = 10
MAX_IMPORT_ROWS = 5000


@dataclass
class ParsedTable:
    columns: list[str]
    mapping: dict[str, str]
    rows: list[MappedRow]

    def column_for(self, target: str) -> str | None:
        return next((column for column, mapped in self.mapping.items() if mapped == target), None)

    @property
    def extra_columns(self) -> list[str]:
        return [column for column, target in self.mapping.items() if target == FIELDS]

    @property
    def pa_names(self) -> list[str]:
        return sorted({row.pa for row in self.rows if row.pa})


def verify_row(row: MappedRow, geocoder: Geocoder) -> dict[str, Any]:
    """Geocode one mapped row and apply the confidence rules. The route address always comes from geocoding,
    never from Places. When geocoding fails, the sheet's own coordinates (if any) are kept and the row is
    `needs_review` (STORE-MODEL §6, assumption)."""
    result: dict[str, Any] = {
        "index": row.index,
        "address": row.address,
        "store_name": row.store_name,
        "external_id": row.external_id,
        "pa": row.pa,
        "status": "invalid",
        "confidence": 0,
        "verified_by": [],
        "formatted": "",
        "addr": row.addr,
        "city": row.city,
        "state": row.state,
        "zip": row.zip,
        "lat": None,
        "lng": None,
        "coordinates_source": "",
        "place_name": "",
        "suggestions": [],
        "error": "",
        "venue_status": row.status.value,
        "venue_status_valid": row.status_valid,
        "venue_status_raw": row.status_raw,
        "installer_name": row.installer_name,
        "details": row.details,
        "screens": row.screens,
        "problems": row.problems,
        "duplicate_of": None,
        "duplicate_reason": "",
        "fields": row.fields,
    }
    query = geocode_query(row)
    if not row.addr.strip() or not query:
        result["error"] = "Missing address"
        return result

    geo = geocoder.geocode(query)
    # Places only confirms a geocoded address (§9 #3: it costs a request per row); a failed geocode has nothing
    # to confirm. Partial matches still get the call.
    place = (
        geocoder.find_place(f"{row.store_name}, {query}" if row.store_name else query)
        if geo.get("ok")
        else {"ok": False}
    )
    result["verified_by"] = [name for name, hit in (("geocoding", geo), ("places", place)) if hit.get("ok")]

    if geo.get("ok"):
        result.update(
            formatted=geo.get("formatted", ""),
            addr=geo.get("addr") or row.addr,
            city=geo.get("city") or row.city,
            state=geo.get("state") or row.state,
            zip=geo.get("zip") or row.zip,
            lat=geo.get("lat"),
            lng=geo.get("lng"),
            coordinates_source="geocode",
            suggestions=geo.get("suggestions", []),
            place_name=(place.get("name") or "") if place.get("ok") else "",
        )
        if geo.get("partial"):
            result.update(status="needs_review", confidence=40, error="Partial match — please review")
        else:
            result.update(status="valid", confidence=100 if place.get("ok") else 70)
        return result

    error = geo.get("error") or "Could not geocode address"
    if row.sheet_lat is not None:
        result.update(lat=row.sheet_lat, lng=row.sheet_lng, coordinates_source="sheet")
        error = f"{error}; the sheet's coordinates are used"
    result.update(
        status="needs_review",
        confidence=0,
        suggestions=geo.get("suggestions") or geocoder.autocomplete(query),
        error=error,
    )
    return result


class ImportService:
    def __init__(
        self,
        jobs: JobRepository | None = None,
        files: FileStore | None = None,
        geocoder: Geocoder | None = None,
        projects: ProjectRepository | None = None,
    ) -> None:
        self._jobs = jobs
        self._files = files
        self._geocoder = geocoder
        self._projects = projects

    @staticmethod
    def parse(filename: str, raw: bytes, saved_mapping: dict[str, str] | None = None) -> ParsedTable:
        """Read the sheet and map its columns. ValueError when no column is the store address."""
        table = read_table(filename, raw)
        columns = list(table[0].keys()) if table else []
        mapping = detect_mapping(columns, saved_mapping)
        if "addr" not in mapping.values():
            raise ValueError("Missing 'address' column")
        return ParsedTable(
            columns=columns,
            mapping=mapping,
            rows=[map_row(index, record, mapping) for index, record in enumerate(table)],
        )

    @staticmethod
    def build_result(table: ParsedTable, verified: list[dict[str, Any]]) -> dict[str, Any]:
        rows = sorted(verified, key=lambda row: row["index"])
        mark_duplicates(rows)
        counts = {
            status: sum(1 for row in rows if row["status"] == status) for status in ("valid", "needs_review", "invalid")
        }
        duplicates = sum(1 for row in rows if row["duplicate_reason"])
        return {
            "columns": table.columns,
            "mapping": table.mapping,
            "address_column": table.column_for("addr") or "",
            "store_column": table.column_for("store_name"),
            "extra_columns": table.extra_columns,
            "summary": {"total": len(rows), **counts, "duplicates": duplicates},
            "pa_names": table.pa_names,
            "rows": rows,
        }

    def _saved_mapping(self, project_id: str | None) -> dict[str, str]:
        if not project_id or self._projects is None:
            return {}
        project = self._projects.get(project_id)
        return dict(project.import_mappings) if project else {}

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
            filename = job.payload.get("filename") or job.payload["upload_key"]
            table = self.parse(filename, raw, self._saved_mapping(job.project_id))
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
            message = f"{summary['valid']} valid, {summary['needs_review']} to review, {summary['invalid']} invalid"
            if summary["duplicates"]:
                message += f", {summary['duplicates']} duplicate"
            if not getattr(self._geocoder, "enabled", True):  # local only: outside local, start() refuses
                message += " (no Google key configured: addresses were not verified)"
                logger.warning("Import ran without a Google key", extra={"job_id": job_id})
            self._jobs.set_result(job_id, key, message=message)
            logger.info("Import finished", extra={"job_id": job_id, **summary})
        except Exception as exc:
            logger.exception("Import failed", extra={"job_id": job_id})
            message = str(exc) if isinstance(exc, (ValueError, KeyError)) else f"Import failed: {exc}"
            try:
                self._jobs.set_status(job_id, JobStatus.FAILED, message=message)
            except Exception:
                logger.exception("Could not mark import job failed", extra={"job_id": job_id})
