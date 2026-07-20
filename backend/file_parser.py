import csv
import io
import re

import pandas as pd


ADDRESS_ALIASES = {"address", "addr", "street_address", "site_address"}
STORE_ALIASES = {"store_name", "store", "site_name", "name"}
PA_ALIASES = {"pa", "pa_name", "principal_agent", "principal_agent_name"}
STATUS_ALIASES = {"status", "venue_status", "installation_status", "site_status"}
VENUE_TYPE_ALIASES = {"venue_type", "venue", "site_type", "location_type"}
DMA_ALIASES = {"dma", "dma_name", "market", "market_name"}
VENUE_CODE_ALIASES = {"venue_code", "site_code", "location_code", "venue_id"}
ALLOWED_STATUSES = {"Incomplete", "Complete", "Technical Issue", "Other"}


def normalize_status(value: object) -> tuple[str, bool]:
    raw = clean_cell(value)
    if not raw:
        return "Incomplete", True
    canonical = {status.lower(): status for status in ALLOWED_STATUSES}
    matched = canonical.get(raw.lower())
    return (matched, True) if matched else ("Incomplete", False)


def normalize_column(value: object) -> str:
    value = str(value).lstrip("\ufeff").strip().lower()
    return re.sub(r"[^a-z0-9]+", "_", value).strip("_")


def clean_cell(value: object) -> str:
    if pd.isna(value):
        return ""
    return str(value).strip()


def read_csv_table(raw: bytes) -> pd.DataFrame:
    """Read CSV, repairing unquoted commas in a two-column address/store file."""
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("cp1252")

    records = list(csv.reader(io.StringIO(text)))
    if not records:
        return pd.DataFrame()

    header = [normalize_column(column) for column in records[0]]
    address_positions = [i for i, column in enumerate(header) if column in ADDRESS_ALIASES]
    store_positions = [i for i, column in enumerate(header) if column in STORE_ALIASES]

    # Some exports leave commas inside addresses unquoted. Treat fields before
    # and after the address column as fixed, and join the extra middle fields.
    if len(address_positions) == 1:
        address_pos = address_positions[0]
        repaired = []
        for record in records[1:]:
            if not record or not any(field.strip() for field in record):
                continue
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
            return pd.DataFrame(repaired, columns=header)

    return pd.read_csv(io.StringIO(text))
