"""Spreadsheet parsing without pandas: header aliases, cell cleaning, CSV repair, XLSX reading."""
from __future__ import annotations

import csv
import io
import math
import re

from openpyxl import load_workbook

ADDRESS_ALIASES = {"address", "addr", "street_address", "site_address"}
STORE_ALIASES = {"store_name", "store", "site_name", "name"}
PA_ALIASES = {"pa", "pa_name", "principal_agent", "principal_agent_name"}
STATUS_ALIASES = {"status", "venue_status", "installation_status", "site_status"}
VENUE_TYPE_ALIASES = {"venue_type", "venue", "site_type", "location_type"}
DMA_ALIASES = {"dma", "dma_name", "market", "market_name"}
VENUE_CODE_ALIASES = {"venue_code", "site_code", "location_code", "venue_id"}
ALLOWED_STATUSES = {"Incomplete", "Complete", "Technical Issue", "Other"}

Row = dict[str, str]


def clean_cell(value: object) -> str:
    """Stringify a cell, treating None and NaN as empty."""
    if value is None:
        return ""
    if isinstance(value, float) and math.isnan(value):
        return ""
    return str(value).strip()


def normalize_column(value: object) -> str:
    text = str(value).lstrip("﻿").strip().lower()
    return re.sub(r"[^a-z0-9]+", "_", text).strip("_")


def normalize_status(value: object) -> tuple[str, bool]:
    """Map a free-text status onto an allowed value. Returns (status, was_recognised)."""
    raw = clean_cell(value)
    if not raw:
        return "Incomplete", True
    canonical = {status.lower(): status for status in ALLOWED_STATUSES}
    matched = canonical.get(raw.lower())
    return (matched, True) if matched else ("Incomplete", False)


def _decode(raw: bytes) -> str:
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("cp1252")


def read_csv_table(raw: bytes) -> list[Row]:
    """Read a CSV into rows keyed by normalised header, repairing unquoted commas inside the address column."""
    records = list(csv.reader(io.StringIO(_decode(raw))))
    if not records:
        return []

    header = [normalize_column(column) for column in records[0]]
    body = [record for record in records[1:] if record and any(field.strip() for field in record)]
    address_positions = [i for i, column in enumerate(header) if column in ADDRESS_ALIASES]

    # Some exports leave commas inside addresses unquoted. Treat fields before and after the
    # address column as fixed and join the extra middle fields back into the address.
    if len(address_positions) == 1:
        address_pos = address_positions[0]
        repaired: list[list[str]] = []
        for record in body:
            extra = len(record) - len(header)
            if extra < 0:
                record = record + [""] * (-extra)
                extra = 0
            address_end = address_pos + extra + 1
            repaired.append(
                [field.strip() for field in record[:address_pos]]
                + [",".join(record[address_pos:address_end]).strip()]
                + [field.strip() for field in record[address_end:]]
            )
        if all(len(record) == len(header) for record in repaired):
            return [dict(zip(header, record, strict=True)) for record in repaired]

    rows: list[Row] = []
    for record in body:
        padded = (record + [""] * len(header))[: len(header)]
        rows.append({column: field.strip() for column, field in zip(header, padded, strict=True)})
    return rows


def read_xlsx_table(raw: bytes) -> list[Row]:
    """Read the first worksheet of an .xlsx file. The first row is the header."""
    workbook = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    try:
        sheet = workbook.worksheets[0]
        rows_iter = sheet.iter_rows(values_only=True)
        header_row = next(rows_iter, None)
        if not header_row:
            return []
        header = [
            normalize_column(cell) if cell is not None and str(cell).strip() else f"column_{index + 1}"
            for index, cell in enumerate(header_row)
        ]
        rows: list[Row] = []
        for values in rows_iter:
            cells = [clean_cell(value) for value in values]
            if not any(cells):
                continue
            cells = (cells + [""] * len(header))[: len(header)]
            rows.append(dict(zip(header, cells, strict=True)))
        return rows
    finally:
        workbook.close()


def read_table(filename: str, raw: bytes) -> list[Row]:
    """Dispatch on extension. Legacy binary .xls is not supported; export it as .xlsx or .csv first."""
    lowered = filename.lower()
    if lowered.endswith(".csv"):
        return read_csv_table(raw)
    if lowered.endswith((".xlsx", ".xlsm", ".xltx", ".xltm")):
        return read_xlsx_table(raw)
    raise ValueError("Unsupported file type. Upload a .csv or .xlsx file.")


def find_column(header: list[str], aliases: set[str]) -> str | None:
    return next((column for column in header if column in aliases), None)
