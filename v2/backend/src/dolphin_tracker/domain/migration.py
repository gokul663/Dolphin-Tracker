"""Pure transform from v1 Mongo documents to v2 records (used by scripts/migrate_from_mongo.py). No I/O.

v1 kept a project's stops embedded in one document and their progress in a separate collection keyed by a
composite string `atl-route-v2|installer|id|addr|lat|lng`. That key appears **only here**, to join the two once.
"""
from __future__ import annotations

import math
import uuid
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from dolphin_tracker.domain.addresses import apply_parsed_address
from dolphin_tracker.domain.kpi import Kpi, kpi_summary
from dolphin_tracker.domain.models import FieldDef, Project, ProjectType, RoutingStatus, Stop, StopStatus
from dolphin_tracker.domain.parsing import clean_cell, normalize_status
from dolphin_tracker.domain.schema import default_field_schema

LEGACY_PROJECT_IDS = frozenset({"atlanta-default"})
LEGACY_FIELD_KEYS = ("pa", "venue_type", "dma", "venue_code", "owner_name", "owner_phone", "owner_email", "payee_name")
V1_CORE_KEYS = frozenset(
    {"id", "addr", "city", "state", "zip", "store_name", "lat", "lng", "geocoded", "installer", "day", "_id"}
)
V1_STOPS_PER_DAY = 8  # v1's hardcoded STOPS_PER_DAY; editable per project after migration
UID_NAMESPACE = uuid.UUID("6f1d3c4e-2b7a-4e0f-9c55-5d1b8a7e0c21")
PROJECT_TYPES = {member.value for member in ProjectType}


def _js_number(value: Any) -> str:
    """How the legacy page's JavaScript printed a coordinate inside the key (`34.0` -> `34`, null -> '')."""
    if value is None or value == "":
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def legacy_keys(stop: Mapping[str, Any]) -> list[str]:
    """Every spelling of v1's composite key for this stop: the browser (JS) one and the Python f-string one.

    The page wrote state with JS formatting; v1's server-side KPI and create code used Python's.
    """
    installer, stop_id, addr = stop.get("installer") or "", stop.get("id") or "", stop.get("addr") or ""
    js = f"atl-route-v2|{installer}|{stop_id}|{addr}|{_js_number(stop.get('lat'))}|{_js_number(stop.get('lng'))}"
    py = (
        f"atl-route-v2|{stop.get('installer', '')}|{stop.get('id', '')}|{stop.get('addr', '')}|"
        f"{stop.get('lat', '')}|{stop.get('lng', '')}"
    )
    return list(dict.fromkeys([js, py]))


def python_key(stop: Mapping[str, Any]) -> str:
    return legacy_keys(stop)[-1]


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _day(value: Any) -> int:
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return 1


def _percentage(value: Any) -> float | None:
    number = _number(value)
    return number if number is not None and 0 <= number <= 100 else None


@dataclass
class ProjectReport:
    project_id: str
    name: str
    stops: int = 0
    states: int = 0
    matched_states: int = 0
    orphan_states: list[str] = field(default_factory=list)
    repaired_addresses: int = 0
    extra_fields: list[str] = field(default_factory=list)
    derived_installers: bool = False  # the v1 doc had no installers list; it was rebuilt from the stops
    unlisted_installer_stops: int = 0  # stops routed to an installer the project's list lacks
    old_kpi: Kpi | None = None
    new_kpi: Kpi | None = None

    @property
    def kpi_matches(self) -> bool:
        return self.old_kpi == self.new_kpi


@dataclass
class Migrated:
    project: Project
    stops: list[Stop]
    report: ProjectReport


def v1_kpi(doc: Mapping[str, Any], states_by_key: Mapping[str, Mapping[str, Any]]) -> Kpi:
    """What the v1 dashboard showed: its kpi_summary joined state on the Python-format key only."""
    rows = []
    for raw in doc.get("stops") or []:
        state = states_by_key.get(python_key(raw), {})
        rows.append(
            {
                "uid": str(raw.get("id", "")),
                "status": state.get("status", "Incomplete"),
                "installer": raw.get("installer", ""),
                "installer_name": state.get("installer_name") or "",
                "fields": {"dma": raw.get("dma", ""), "venue_type": raw.get("venue_type", "")},
                **{part: raw.get(part, "") for part in ("addr", "city", "state", "zip")},
            }
        )
    return kpi_summary(rows)


def transform_project(doc: Mapping[str, Any], states: Iterable[Mapping[str, Any]]) -> Migrated:
    """One v1 project document plus its state documents → v2 Project, Stops and a parity report."""
    project_id = str(doc["id"])
    states_by_key = {str(state.get("stop_key")): state for state in states if state.get("stop_key")}
    report = ProjectReport(project_id=project_id, name=str(doc.get("name", "")), states=len(states_by_key))
    report.old_kpi = v1_kpi(doc, states_by_key)

    raw_stops = [dict(stop) for stop in doc.get("stops") or []]
    extra_keys = sorted(
        {
            key
            for stop in raw_stops
            for key, value in stop.items()
            if key not in V1_CORE_KEYS and key not in LEGACY_FIELD_KEYS and clean_cell(value)
        }
    )
    schema = default_field_schema() + [FieldDef(key=key, label=key.replace("_", " ").title()) for key in extra_keys]
    report.extra_fields = extra_keys

    matched: set[str] = set()
    seq_counter: dict[tuple[str, int], int] = defaultdict(int)
    stops: list[Stop] = []
    for index, raw in enumerate(raw_stops):
        keys = legacy_keys(raw)
        repaired = dict(raw)
        if apply_parsed_address(repaired):
            report.repaired_addresses += 1
            keys += [key for key in legacy_keys(repaired) if key not in keys]
        state_key_hit = next((key for key in keys if key in states_by_key), None)
        state = states_by_key.get(state_key_hit, {}) if state_key_hit else {}
        if state_key_hit:
            matched.add(state_key_hit)

        installer = clean_cell(raw.get("installer"))
        day = _day(raw.get("day"))
        seq = seq_counter[(installer, day)]
        seq_counter[(installer, day)] += 1

        fields = {key: clean_cell(raw.get(key)) for key in LEGACY_FIELD_KEYS if clean_cell(raw.get(key))}
        fields.update({key: clean_cell(raw.get(key)) for key in extra_keys if clean_cell(raw.get(key))})
        if clean_cell(state.get("venue_code")):
            fields["venue_code"] = clean_cell(state.get("venue_code"))  # v1 detail edits stored it on the state

        status, _ = normalize_status(state.get("status", "Incomplete"))
        additional_task = state.get("additional_task")
        if additional_task is None:
            additional_task = state.get("modem", False)  # the legacy ARA flag maps onto additional_task
        stop_id = str(raw.get("id") or f"S{index + 1}")
        stops.append(
            Stop(
                uid=str(uuid.uuid5(UID_NAMESPACE, f"{project_id}|{index}|{stop_id}")),  # stable across re-runs
                display_id=stop_id,
                store_name=clean_cell(state.get("store_name")) or clean_cell(repaired.get("store_name")),
                addr=clean_cell(repaired.get("addr")),
                city=clean_cell(repaired.get("city")),
                state=clean_cell(repaired.get("state")),
                zip=clean_cell(repaired.get("zip")),
                lat=_number(raw.get("lat")),
                lng=_number(raw.get("lng")),
                geocoded=clean_cell(raw.get("geocoded")),
                installer=installer,
                day=day,
                seq=seq,
                fields=fields,
                status=StopStatus(status),
                comment=clean_cell(state.get("comment")),
                additional_task=bool(additional_task),
                installer_name=clean_cell(state.get("installer_name")),
                updated_by=clean_cell(state.get("updatedBy") or state.get("updated_by")),
                **({"updated_at": str(state["updatedAt"])} if state.get("updatedAt") else {}),
            )
        )
    report.stops = len(stops)
    report.matched_states = len(matched)
    report.orphan_states = sorted(set(states_by_key) - matched)

    installers = [name for name in (clean_cell(item) for item in doc.get("installers") or []) if name]
    if not installers:  # v1 derived the list from the stops when the doc had none
        installers = list(dict.fromkeys(stop.installer for stop in stops if stop.installer))
        report.derived_installers = bool(installers)
    report.unlisted_installer_stops = sum(1 for stop in stops if stop.installer and stop.installer not in installers)

    project_type = str(doc.get("project_type") or "")
    created_at = str(doc.get("created_at") or "") or None
    project = Project(
        id=project_id,
        name=clean_cell(doc.get("name")) or project_id,
        pa=clean_cell(doc.get("pa")),
        project_type=ProjectType(project_type) if project_type in PROJECT_TYPES else ProjectType.NEW_INSTALLATION,
        installers=installers,
        field_agent=clean_cell(doc.get("field_agent")),
        partner_account=clean_cell(doc.get("partner_account")),
        pa_percentage=_percentage(doc.get("pa_percentage")),
        dolphin_percentage=_percentage(doc.get("dolphin_percentage")),
        store_percentage=_percentage(doc.get("store_percentage")),
        fa_percentage=_percentage(doc.get("fa_percentage")),
        stops_per_day=V1_STOPS_PER_DAY,
        field_schema=schema,
        routing_status=RoutingStatus.READY,
        stop_count=len(stops),
        **({"created_at": created_at} if created_at else {}),
        **({"updated_at": str(doc["updated_at"])} if doc.get("updated_at") else {}),
    )
    report.new_kpi = kpi_summary(stop.model_dump(mode="json") for stop in stops)
    return Migrated(project=project, stops=stops, report=report)


def format_report(reports: Iterable[ProjectReport]) -> str:
    """Plain-text parity report: counts and per-project KPI old vs new."""
    lines = []
    header = (
        f"{'project':<38} {'stops':>6} {'states':>7} {'matched':>8} {'orphan':>7} "
        f"{'old c/p/t/o':>16} {'new c/p/t/o':>16}"
    )
    lines.append(header)
    lines.append("-" * len(header))
    totals = defaultdict(int)
    for report in reports:
        old, new = report.old_kpi, report.new_kpi
        old_counts = f"{old.complete}/{old.pending}/{old.technical}/{old.other}" if old else "-"
        new_counts = f"{new.complete}/{new.pending}/{new.technical}/{new.other}" if new else "-"
        flag = "" if report.kpi_matches else "  << KPI differs"
        lines.append(
            f"{report.name[:38]:<38} {report.stops:>6} {report.states:>7} {report.matched_states:>8} "
            f"{len(report.orphan_states):>7} {old_counts:>16} {new_counts:>16}{flag}"
        )
        for key in report.orphan_states:
            lines.append(f"    orphan state: {key}")
        if report.repaired_addresses:
            lines.append(f"    addresses repaired from geocoded text: {report.repaired_addresses}")
        if report.derived_installers:
            lines.append("    installers derived from stops (the v1 doc had none)")
        if report.unlisted_installer_stops:
            lines.append(f"    stops on unlisted installer: {report.unlisted_installer_stops}")
        if report.extra_fields:
            lines.append(f"    extra attributes kept as schema fields: {', '.join(report.extra_fields)}")
        for name in ("stops", "states", "matched_states"):
            totals[name] += getattr(report, name)
        totals["orphans"] += len(report.orphan_states)
    lines.append("-" * len(header))
    lines.append(
        f"{'TOTAL':<38} {totals['stops']:>6} {totals['states']:>7} {totals['matched_states']:>8} {totals['orphans']:>7}"
    )
    return "\n".join(lines)


def is_legacy(project_id: str) -> bool:
    return project_id in LEGACY_PROJECT_IDS
