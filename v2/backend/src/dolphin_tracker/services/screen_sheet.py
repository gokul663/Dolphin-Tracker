"""The screen cost sheet (Settings): one row per DD code with the screen's size, whether Dolphin supplied a screen
(Screen Count) and what the hardware cost. Matched to the project's screens by DD code; it sets the size and who
the screen belongs to, and its cost is checked against the project's price list (never stored: costs come from the
prices)."""
from __future__ import annotations

import base64
import binascii
import re

from dolphin_tracker.domain.base import ApiModel
from dolphin_tracker.domain.device import split_codes, venue_code_key
from dolphin_tracker.domain.errors import NotFoundError, ValidationFailed
from dolphin_tracker.domain.models import HardwareCosts, Screen, Stop
from dolphin_tracker.domain.parsing import Row, read_table
from dolphin_tracker.domain.statuses import screen_size_label
from dolphin_tracker.domain.validation import normalize_external_id
from dolphin_tracker.repositories.projects import ProjectRepository
from dolphin_tracker.repositories.stores import StoreRepository

MAX_BYTES = 3_000_000
MAX_ROWS = 20_000
# Normalised header → what it is; the first one a sheet has is used.
COLUMNS = {
    "dd_code": ("venue_id", "dd_code", "dd", "venue", "dd_codes"),
    "external_id": ("extid", "ext_id", "ibc", "ibc_id", "ibc_number", "external_id", "store_id"),
    "size": ("screen_size", "size", "tv_size"),
    "stick_count": ("stick_count", "sticks", "stick"),
    "screen_count": ("screen_count", "screens", "dolphin_screens"),
    "cost": ("cost_per_screen", "cost", "screen_cost", "hardware_cost"),
    "note": ("cost_note", "note", "notes"),
}


class SheetScreenRow(ApiModel):
    """One row of the sheet against the project."""

    row: int  # the sheet's row number (the header is row 1)
    dd_code: str
    external_id: str = ""
    note: str = ""
    matched: bool = False
    store_uid: str = ""
    store_name: str = ""
    store_external_id: str = ""
    ibc_differs: bool = False  # the sheet names another ExtID than the store this DD code is at
    size_from: str = ""
    size_to: str = ""
    dolphin_from: bool | None = None  # owned by Dolphin, before and after
    dolphin_to: bool | None = None
    changes: bool = False  # the size or the owner changes
    stick_count: int = 1  # the sheet's; 1 when the row has none
    screen_count: int | None = None  # the sheet's Dolphin screens on this DD code; None when the row has none
    sheet_cost: float | None = None  # only when the sheet carries a cost column
    # Worked out from the price list: sticks × the stick price + Dolphin screens × the price of that size.
    our_cost: float | None = None
    cost_differs: bool = False
    problem: str = ""  # why the row cannot be used


class ScreenSheetResult(ApiModel):
    rows: list[SheetScreenRow]
    matched: int = 0
    changing: int = 0
    unmatched: int = 0
    cost_differs: int = 0
    total_cost: float = 0  # the worked-out cost of the matched rows that could be priced
    unpriced: int = 0  # matched rows with no price for their size (or no stick price) in Settings
    applied: bool = False
    screens_updated: int = 0


def _pick(row: Row, name: str) -> str:
    return next((row[key].strip() for key in COLUMNS[name] if row.get(key, "").strip()), "")


def _money(text: str) -> float | None:
    cleaned = re.sub(r"[^0-9.\-]", "", text)
    try:
        return float(cleaned) if cleaned else None
    except ValueError:
        return None


def screen_cost(
    costs: HardwareCosts, size: str, screens: int, sticks: int = 1, screen_type: str = ""
) -> float | None:
    """What a row's hardware costs by the price list: its sticks, plus its Dolphin-owned screens at the price of
    their size (the type's row, else the size's default). No Dolphin screen (0) is the store's own TV: sticks only.
    None while a needed price is not set."""
    if costs.stick is None:
        return None
    total = sticks * costs.stick
    if screens <= 0:
        return total
    rows = [row for row in costs.screens if row.size == (screen_size_label(size) or '24"')]
    wanted = screen_type.strip().lower()
    typed = next((r for r in rows if wanted and r.type.lower() == wanted), None)
    row = typed or next((r for r in rows if r.is_default), None)
    return None if row is None or row.cost is None else total + screens * row.cost


class ScreenSheetService:
    def __init__(self, projects: ProjectRepository, stores: StoreRepository) -> None:
        self._projects, self._stores = projects, stores

    def run(self, project_id: str, filename: str, content_base64: str, *, apply: bool = False) -> ScreenSheetResult:
        """Read the sheet and line it up with the project's screens; with `apply`, also write the sizes and owners
        that differ. Rows whose DD code is in no store, or that lack a size, change nothing."""
        project = self._projects.get(project_id)
        if project is None:
            raise NotFoundError(f"Project {project_id} not found")
        try:
            raw = base64.b64decode(content_base64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValidationFailed("The file could not be read") from exc
        if len(raw) > MAX_BYTES:
            raise ValidationFailed("The sheet is too large (3 MB at most)")
        try:
            table = read_table(filename, raw)
        except ValueError as exc:
            raise ValidationFailed(str(exc)) from exc
        if len(table) > MAX_ROWS:
            raise ValidationFailed(f"The sheet has more than {MAX_ROWS:,} rows")
        if table and not any(key in table[0] for key in COLUMNS["dd_code"]):
            raise ValidationFailed("The sheet needs a Venue ID (DD code) column")

        stops = self._stores.list_all(project_id)
        where: dict[str, tuple[Stop, Screen]] = {}
        for stop in stops:
            for screen in stop.screens:
                for code in split_codes(screen.venue_id):
                    where.setdefault(venue_code_key(code), (stop, screen))

        rows: list[SheetScreenRow] = []
        wanted: dict[str, dict[str, tuple[str, bool]]] = {}  # store uid → screen id → (size, owned by Dolphin)
        for number, line in enumerate(table, start=2):
            code = _pick(line, "dd_code")
            if not code:
                continue
            size = screen_size_label(_pick(line, "size"))
            count = _money(_pick(line, "screen_count"))
            item = SheetScreenRow(row=number, dd_code=code, external_id=_pick(line, "external_id"),
                                  note=_pick(line, "note"), sheet_cost=_money(_pick(line, "cost")), size_to=size)
            found = where.get(venue_code_key(code))
            if found is None:
                item.problem = "This DD code is on no screen of the project"
            else:
                stop, screen = found
                item.matched = True
                item.store_uid, item.store_name, item.store_external_id = stop.uid, stop.store_name, stop.external_id
                item.ibc_differs = bool(item.external_id and stop.external_id) and (
                    normalize_external_id(item.external_id) != normalize_external_id(stop.external_id))
                item.size_from, item.dolphin_from = screen.screen_size, screen.is_dolphin_screen
                # No Screen Count on the row: the owner stays as it is.
                item.dolphin_to = screen.is_dolphin_screen if count is None else count >= 1
                if not size:
                    item.size_to = screen.screen_size
                    item.problem = "No screen size on this row: the size stays as it is"
                item.changes = (item.size_to, item.dolphin_to) != (item.size_from, item.dolphin_from)
                sticks = _money(_pick(line, "stick_count"))
                item.stick_count = 1 if sticks is None else int(sticks)
                item.screen_count = None if count is None else int(count)
                screens = int(item.dolphin_to) if count is None else int(count)
                item.our_cost = screen_cost(project.hardware_costs, item.size_to, screens, item.stick_count,
                                            screen.screen_type)
                item.cost_differs = (item.sheet_cost is not None and item.our_cost is not None
                                     and abs(item.sheet_cost - item.our_cost) >= 0.005)
                if item.changes:
                    wanted.setdefault(stop.uid, {})[screen.id] = (item.size_to, bool(item.dolphin_to))
            rows.append(item)

        result = ScreenSheetResult(
            rows=rows, matched=sum(row.matched for row in rows), changing=sum(row.changes for row in rows),
            unmatched=sum(not row.matched for row in rows), cost_differs=sum(row.cost_differs for row in rows),
            total_cost=sum(row.our_cost or 0 for row in rows if row.matched),
            unpriced=sum(row.matched and row.our_cost is None for row in rows),
        )
        if apply:
            by_uid = {stop.uid: stop for stop in stops}
            for uid, changes in wanted.items():
                screens = [
                    screen.model_copy(update={"screen_size": changes[screen.id][0],
                                              "is_dolphin_screen": changes[screen.id][1]})
                    if screen.id in changes else screen
                    for screen in by_uid[uid].screens
                ]
                self._stores.update_screens(project_id, uid, screens, updated_by="Screen cost sheet")
                result.screens_updated += len(changes)
            result.applied = True
        return result
