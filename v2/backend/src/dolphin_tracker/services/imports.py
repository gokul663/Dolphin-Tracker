"""Spreadsheet import. Parsing is implemented; geocoding and job orchestration arrive in Phase 2."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

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

CORE_ALIASES = (
    ADDRESS_ALIASES
    | STORE_ALIASES
    | PA_ALIASES
    | STATUS_ALIASES
    | VENUE_TYPE_ALIASES
    | DMA_ALIASES
    | VENUE_CODE_ALIASES
)


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

    @property
    def pa_names(self) -> list[str]:
        return sorted({row.pa for row in self.rows if row.pa})


class ImportService:
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
        venue_type_column = find_column(columns, VENUE_TYPE_ALIASES)
        dma_column = find_column(columns, DMA_ALIASES)
        venue_code_column = find_column(columns, VENUE_CODE_ALIASES)
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
                    venue_type=record.get(venue_type_column, "") if venue_type_column else "",
                    dma=record.get(dma_column, "") if dma_column else "",
                    venue_code=record.get(venue_code_column, "") if venue_code_column else "",
                    extra={column: record.get(column, "") for column in extra_columns},
                )
            )
        return ParsedTable(
            rows=rows,
            columns=columns,
            address_column=address_column,
            store_column=store_column,
            extra_columns=extra_columns,
        )

    def run(self, job_id: str, event: dict[str, Any]) -> None:
        """Worker entry point for an import_parse job."""
        raise NotImplementedError(
            "Phase 2: fetch upload from S3, parse, geocode rows with a thread pool, write progress, store results"
        )
