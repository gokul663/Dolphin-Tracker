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

from dolphin_tracker.domain.errors import ConflictError, NotFoundError, ValidationFailed
from dolphin_tracker.domain.import_mapping import (
    FIELDS,
    MappedRow,
    check_mapping,
    detect_mapping,
    geocode_query,
    map_row,
    mark_duplicates,
)
from dolphin_tracker.domain.models import JobStatus, JobType
from dolphin_tracker.domain.parsing import read_table
from dolphin_tracker.repositories.files import FileStore, result_key
from dolphin_tracker.repositories.jobs import JobRepository
from dolphin_tracker.repositories.projects import ProjectRepository
from dolphin_tracker.services.geocoding import Geocoder, house_number, resolve_address

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


# Result keys that come from geocoding a row; a re-map keeps them (see `ImportService.remap`).
GEOCODE_KEYS = (
    "status", "confidence", "verified_by", "formatted", "addr", "city", "state", "zip", "lat", "lng",
    "coordinates_source", "place_name", "suggestions", "error",
)
GEOCODED_TARGETS = ("addr", "city", "state", "zip", "lat", "lng")


def carry_geocoding(row: dict[str, Any], previous: dict[str, Any]) -> dict[str, Any]:
    return {**row, **{key: previous[key] for key in GEOCODE_KEYS if key in previous}}


def verify_inputs(row: MappedRow) -> dict[str, Any]:
    """A result row from the sheet alone, before geocoding (the mapping-derived part)."""
    return {
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


def verify_row(row: MappedRow, geocoder: Geocoder) -> dict[str, Any]:
    """Geocode one mapped row and apply the confidence rules. The route address always comes from geocoding,
    never from Places. When geocoding fails, the sheet's own coordinates (if any) are kept and the row is
    `needs_review` (STORE-MODEL §6, assumption)."""
    result = verify_inputs(row)
    query = geocode_query(row)
    if not row.addr.strip() or not query:
        result["error"] = "Missing address"
        return result

    geo = resolve_address(geocoder, query, row.store_name)
    if geo.get("matched_by") == "places":
        place = {"ok": True, "name": geo.get("place_name") or ""}  # the business itself placed the store
    else:
        # Places only confirms a geocoded address (§9 #3: it costs a request per row); a failed geocode has
        # nothing to confirm. Partial matches still get the call. A place at another house number confirms nothing.
        place = (
            geocoder.find_place(f"{row.store_name}, {query}" if row.store_name else query)
            if geo.get("ok")
            else {"ok": False}
        )
        if place.get("ok") and house_number(place.get("formatted") or "") != house_number(query):
            place = {"ok": False}
    first = {"autocomplete": "autocomplete", "places": "places"}.get(geo.get("matched_by") or "", "geocoding")
    result["verified_by"] = [name for name, hit in ((first, geo), ("places", place)) if hit.get("ok")]
    result["verified_by"] = list(dict.fromkeys(result["verified_by"]))

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
            result.update(
                status="needs_review",
                confidence=40,
                error="Google could not find this house number — pick a suggestion or correct the address",
            )
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
        suggestions=geo.get("suggestions") or [],
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

    def remap(self, job_id: str, mapping: dict[str, str]) -> dict[str, Any]:
        """Re-map a finished import with a re-pointed mapping (the review step's per-column control).

        The stored sheet is parsed again with `mapping`; each row keeps its geocoding from the stored result, so
        Google is not called again. That is only sound while the address and coordinate columns stay where
        they were, so re-pointing those is refused (re-upload instead). The new result replaces the stored one."""
        assert self._jobs is not None and self._files is not None
        job = self._jobs.get(job_id)
        if job is None:
            raise NotFoundError(f"Job {job_id} not found")
        if job.type != JobType.IMPORT_PARSE or job.status != JobStatus.SUCCEEDED or not job.result_key:
            raise ConflictError("Only a finished import can be re-mapped")
        previous = self._files.get_json(job.result_key)
        before = previous.get("mapping", {})
        problems = check_mapping(mapping)
        if set(mapping) != set(before):
            problems.append("The mapping must list exactly the sheet's columns")
        moved = sorted(
            target for target in GEOCODED_TARGETS
            if [c for c, t in before.items() if t == target] != [c for c, t in mapping.items() if t == target]
        )
        if moved:
            problems.append(f"Re-upload the sheet to change the address columns ({', '.join(moved)})")
        if problems:
            raise ValidationFailed("The mapping cannot be applied", errors=problems)

        raw = self._files.get_bytes(job.payload["upload_key"])
        table = read_table(job.payload.get("filename") or job.payload["upload_key"], raw)
        columns = list(table[0].keys()) if table else []
        mapped = [map_row(index, record, mapping) for index, record in enumerate(table)]
        parsed = ParsedTable(columns=columns, mapping=dict(mapping), rows=mapped)
        geocoded = {row["index"]: row for row in previous.get("rows", [])}
        rows = [carry_geocoding(verify_inputs(row), geocoded.get(row.index, {})) for row in parsed.rows]
        result = self.build_result(parsed, rows)
        self._files.put_json(job.result_key, result)
        return result

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
