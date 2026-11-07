"""Route plans (ROUTE-PLANNER §3, §4, §7): records and the pure day builder around the existing optimizer.

A plan holds stores from any project. Each installer has a start location. Day numbers are absolute: days up to
`current_day` have started (they have a date), later days are a forecast that is rebuilt freely. A plan stop is
*visited* once every stick it had when it joined the plan has a visit logged against this plan; visited stops
never move again.
"""
from __future__ import annotations

import itertools
import uuid
from collections.abc import Callable
from enum import StrEnum
from typing import Any

from pydantic import Field, field_validator, model_validator

from dolphin_tracker.domain.base import ApiModel
from dolphin_tracker.domain.lists import clean_name, name_key
from dolphin_tracker.domain.models import now_iso
from dolphin_tracker.domain.route_optimizer import (
    center,
    distance,
    geographic_clusters,
    haversine,
    make_state_day_batches,
    optimize_existing_day,
    optimize_route,
    state_key,
)
from dolphin_tracker.domain.visits import DATE_PATTERN

MAX_PLAN_STORES = 2000
MAX_PLAN_INSTALLERS = 50
MAX_DAY_HOURS = 24

Point = tuple[float, float]  # (lat, lng)
DriveTimes = Callable[[list[Point]], list[float]]  # points → minutes for each consecutive leg
ROAD_FACTOR = 1.3  # straight line → road distance, for the fallback estimate
ESTIMATE_MPH = 40.0


class PlanStatus(StrEnum):
    ACTIVE = "active"
    CLOSED = "closed"


class Replan(StrEnum):
    """How much of a plan a change rebuilds."""

    NONE = "none"
    FORECAST = "forecast"  # days after the current one; today's routes stay as they are
    TODAY = "today"  # every open stop, from the current day's starts (today is rebuilt too)


class StartLocation(ApiModel):
    address: str = Field(min_length=1, max_length=500)
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class PlanInstaller(ApiModel):
    name: str = Field(min_length=1, max_length=200)
    start: StartLocation

    @field_validator("name", mode="before")
    @classmethod
    def _clean(cls, value: object) -> object:
        return clean_name(value) if isinstance(value, str) else value


class PlanDay(ApiModel):
    """A started day: its date, where each installer set off from, and the limits it was planned with. None means
    the plan's defaults (the values chosen when the plan was created, editable in the plan settings)."""

    number: int = Field(ge=1)
    date: str = Field(pattern=DATE_PATTERN)
    starts: dict[str, StartLocation] = Field(default_factory=dict)
    stops_per_day: int | None = Field(default=None, ge=1, le=50)
    max_day_hours: float | None = Field(default=None, ge=0, le=MAX_DAY_HOURS)


class DayLock(ApiModel):
    """One installer's day kept as it is: recalculations leave its stores and their order alone."""

    installer: str = Field(min_length=1, max_length=200)
    day: int = Field(ge=1)


def check_installers(installers: list[PlanInstaller]) -> None:
    if not installers:
        raise ValueError("At least one installer is required")
    if len(installers) > MAX_PLAN_INSTALLERS:
        raise ValueError(f"At most {MAX_PLAN_INSTALLERS} installers")
    keys = [name_key(installer.name) for installer in installers]
    if len(set(keys)) != len(keys):
        raise ValueError("Installer names must be unique")


class RoutePlan(ApiModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    name: str = Field(min_length=1, max_length=200)
    status: PlanStatus = PlanStatus.ACTIVE
    stops_per_day: int = Field(default=10, ge=1, le=50)
    # Longest driving day in hours (drive time only, no return trip); 0 = no limit. A day ends at whichever of
    # this and stops_per_day comes first.
    max_day_hours: float = Field(default=0, ge=0, le=MAX_DAY_HOURS)
    installers: list[PlanInstaller]
    days: list[PlanDay]  # started days, oldest first; the last one is the current day
    locked_days: list[DayLock] = Field(default_factory=list)
    store_count: int = 0
    version: int = 1
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)
    closed_at: str = ""

    @model_validator(mode="after")
    def _shape(self) -> RoutePlan:
        check_installers(self.installers)
        if not self.days:
            raise ValueError("A plan starts with day 1")
        return self

    @property
    def current_day(self) -> int:
        return self.days[-1].number

    def locked(self) -> set[tuple[str, int]]:
        return {(lock.installer, lock.day) for lock in self.locked_days}

    def limits(self, day: PlanDay | None = None) -> tuple[int, float]:
        """(stops per day, max driving hours) for `day`: its own values, else the plan's defaults."""
        if day is None:
            return self.stops_per_day, self.max_day_hours
        per_day = day.stops_per_day if day.stops_per_day is not None else self.stops_per_day
        hours = day.max_day_hours if day.max_day_hours is not None else self.max_day_hours
        return per_day, hours

    def installer_names(self) -> list[str]:
        return [installer.name for installer in self.installers]


class PlanStopState(StrEnum):
    OPEN = "open"
    VISITED = "visited"


class PlanStop(ApiModel):
    """One store in a plan: a snapshot of where it is, plus its assignment. `day` 0 means not placed (no installer
    could take it), which only happens transiently."""

    project_id: str
    stop_uid: str
    external_id: str = ""
    store_name: str = ""
    addr: str = ""
    city: str = ""
    state: str = ""
    zip: str = ""
    lat: float | None = None
    lng: float | None = None
    screen_ids: list[str] = Field(default_factory=list)
    installer: str = ""
    day: int = 0
    seq: int = 0
    # Driving minutes from the previous point: the day's start for the first stop, else the stop before. None when
    # unknown (no coordinates, or laid out before drive times were kept).
    drive_minutes: int | None = None
    visited_screens: list[str] = Field(default_factory=list)
    added_at: str = Field(default_factory=now_iso)

    @property
    def key(self) -> str:
        return plan_stop_key(self.project_id, self.stop_uid)

    @property
    def state_value(self) -> PlanStopState:
        if self.screen_ids and set(self.screen_ids) <= set(self.visited_screens):
            return PlanStopState.VISITED
        return PlanStopState.OPEN

    @property
    def located(self) -> bool:
        return self.lat is not None and self.lng is not None


def plan_stop_key(project_id: str, stop_uid: str) -> str:
    return f"{project_id}#{stop_uid}"


# ---- building days ----------------------------------------------------------------------------------------------
#
# The optimizer itself (clustering, day batching, 2-opt) is unchanged. Two approved changes sit at its edges
# (ROUTE-PLANNER §7): clusters go to the installer whose start is nearest, and the first day is ordered from the
# installer's start.

Assignment = dict[str, tuple[str, int, int, int | None]]  # plan stop key → (installer, day, seq, drive minutes)


def estimate_leg_minutes(points: list[Point]) -> list[float]:
    """Straight-line distance × ROAD_FACTOR at ESTIMATE_MPH: the fallback when Google is unavailable."""
    return [haversine(*a, *b) * ROAD_FACTOR / ESTIMATE_MPH * 60 for a, b in itertools.pairwise(points)]


def _point(row: dict[str, Any]) -> Point | None:
    if row.get("lat") is None or row.get("lng") is None:
        return None
    return (float(row["lat"]), float(row["lng"]))


def chain_legs(origin: dict[str, Any], rows: list[dict[str, Any]], drive_times: DriveTimes) -> dict[str, int | None]:
    """Row id → driving minutes from the previous located point (`origin` for the first). Rows without
    coordinates get None and are skipped over."""
    located = [row for row in rows if _point(row) is not None]
    start = _point(origin)
    points = ([start] if start else []) + [_point(row) for row in located]
    legs = drive_times(points) if len(points) > 1 else []  # type: ignore[arg-type]
    if start is None:  # no origin: the first located row has no leg
        legs = [0.0, *legs]
    minutes: dict[str, int | None] = {row["id"]: None for row in rows}
    for row, leg in zip(located, legs, strict=False):
        minutes[row["id"]] = round(leg)
    return minutes


def split_long_days(
    routes: dict[str, list[list[dict[str, Any]]]],
    starts: dict[str, dict[str, Any]],
    drive_times: DriveTimes,
    max_minutes: float,
) -> tuple[dict[str, list[list[dict[str, Any]]]], dict[str, int | None]]:
    """Each installer's days, with any day whose driving passes `max_minutes` cut into more days, and every row's
    driving minutes from the previous point. The installer drives start → day 1 → day 2 ..., sleeping near the
    last stop of each day, so a day's first leg runs from the previous day's last stop and there is no return
    trip. A day is never merged with another, and a single stop longer than the limit still gets a day."""
    result: dict[str, list[list[dict[str, Any]]]] = {}
    minutes: dict[str, int | None] = {}
    for installer, days in routes.items():
        legs = chain_legs(starts[installer], [row for day in days for row in day], drive_times)
        minutes.update(legs)
        split: list[list[dict[str, Any]]] = []
        for day in days:
            current: list[dict[str, Any]] = []
            total = 0
            for row in day:
                leg = legs.get(row["id"]) or 0
                if max_minutes and current and total + leg > max_minutes:
                    split.append(current)
                    current, total = [], 0
                current.append(row)
                total += leg
            if current:
                split.append(current)
        result[installer] = split
    return result, minutes


def match_clusters(clusters: list[list[dict]], starts: list[dict]) -> list[int | None]:
    """For each start, the index of the cluster it gets (None when there are fewer clusters than starts),
    minimising the total start → cluster-centre distance. Exhaustive up to 7 starts (when no start is left
    without a cluster to spare), greedy otherwise."""
    if not clusters:
        return [None] * len(starts)
    centres = [center(cluster) for cluster in clusters]
    cost = [[haversine(start["lat"], start["lng"], *centre) for centre in centres] for start in starts]
    if len(starts) <= 7 and len(clusters) <= len(starts):
        # Every cluster is used; starts beyond the cluster count get None. At most 7! orderings.
        best: tuple[float, tuple[int | None, ...]] | None = None
        slots: list[int | None] = [*range(len(clusters)), *[None] * (len(starts) - len(clusters))]
        for perm in set(itertools.permutations(slots)):
            total = sum(cost[i][c] for i, c in enumerate(perm) if c is not None)
            if best is None or total < best[0]:
                best = (total, perm)
        assert best is not None
        return list(best[1])
    result: list[int | None] = [None] * len(starts)
    pairs = sorted((cost[i][c], i, c) for i in range(len(starts)) for c in range(len(clusters)))
    used_starts: set[int] = set()
    used_clusters: set[int] = set()
    for _, i, c in pairs:
        if i in used_starts or c in used_clusters:
            continue
        result[i] = c
        used_starts.add(i)
        used_clusters.add(c)
    return result


def anchor_days(days: list[list[dict]], start: dict) -> list[list[dict]]:
    """Run the day sequence from the end nearest the start, and order the first day from the start."""
    if not days:
        return []
    if len(days) > 1 and distance(start, days[-1][-1]) < distance(start, days[0][0]):
        days = [list(reversed(day)) for day in reversed(days)]
    return [optimize_route(days[0], start), *days[1:]]


def build_days(
    rows: list[dict[str, Any]], starts: dict[str, dict[str, Any]], per_day: int
) -> dict[str, list[list[dict[str, Any]]]]:
    """installer → days (from 1) → rows in visiting order. `rows` carry `id`, `lat`, `lng`, `state`; `starts` maps
    each installer to a point with `lat`/`lng`. Rows without coordinates go round-robin to the installers, onto a
    day of their state with room, else a new day (as the project routing did)."""
    installers = list(starts)
    routes: dict[str, list[list[dict[str, Any]]]] = {installer: [] for installer in installers}
    if not installers or not rows:
        return routes
    located = [row for row in rows if row.get("lat") is not None and row.get("lng") is not None]
    missing = [row for row in rows if not (row.get("lat") is not None and row.get("lng") is not None)]
    if located:
        clusters = geographic_clusters(located, min(len(located), len(installers)))
        picks = match_clusters(clusters, [starts[installer] for installer in installers])
        for installer, pick in zip(installers, picks, strict=True):
            if pick is not None:
                routes[installer] = anchor_days(make_state_day_batches(clusters[pick], per_day), starts[installer])
    for index, row in enumerate(missing):
        days = routes[installers[index % len(installers)]]
        target = next(
            (day for day in days if len(day) < per_day and all(state_key(r) == state_key(row) for r in day)), None
        )
        if target is None:
            target = []
            days.append(target)
        target.append(row)
    return routes


def plan_row(stop: PlanStop) -> dict[str, Any]:
    return {"id": stop.key, "lat": stop.lat, "lng": stop.lng, "state": stop.state}


def assign(
    stops: list[PlanStop],
    starts: dict[str, StartLocation],
    per_day: int,
    first_day: int,
    *,
    max_day_hours: float = 0,
    drive_times: DriveTimes = estimate_leg_minutes,
) -> Assignment:
    """Lay `stops` out over days `first_day`, `first_day + 1`, ... per installer: at most `per_day` stops and, when
    set, at most `max_day_hours` of driving a day."""
    points = {name: {"lat": start.lat, "lng": start.lng} for name, start in starts.items()}
    routes = build_days([plan_row(stop) for stop in stops], points, per_day)
    routes, minutes = split_long_days(routes, points, drive_times, max_day_hours * 60)
    result: Assignment = {}
    for installer, days in routes.items():
        for offset, day in enumerate(days):
            for seq, row in enumerate(day):
                result[row["id"]] = (installer, first_day + offset, seq, minutes.get(row["id"]))
    return result


def skip_locked(assignment: Assignment, locked: set[tuple[str, int]]) -> Assignment:
    """Move each installer's laid-out days past their locked days: day N of the layout lands on the Nth day that is
    not locked, counting from the layout's first day."""
    days: dict[str, list[int]] = {}
    for installer, day, _, _ in assignment.values():
        days.setdefault(installer, [])
        if day not in days[installer]:
            days[installer].append(day)
    moved: dict[tuple[str, int], int] = {}
    for installer, numbers in days.items():
        free = min(numbers)
        for number in sorted(numbers):
            while (installer, free) in locked:
                free += 1
            moved[(installer, number)] = free
            free += 1
    return {key: (inst, moved[(inst, day)], seq, minutes) for key, (inst, day, seq, minutes) in assignment.items()}


class InsertOption(ApiModel):
    """Putting a store at `position` in a day's order (0 = first): between `after` and `before` (store names; ""
    for the day's start or end), costing `extra_minutes` more driving."""

    position: int
    after: str
    before: str
    extra_minutes: int
    best: bool = False


def insertion_options(
    origin: dict[str, Any], day: list[dict[str, Any]], new: dict[str, Any], drive_times: DriveTimes
) -> list[InsertOption]:
    """Every place `new` can go in `day` (rows in order, with `name`, `lat`, `lng` and `leg`: minutes from the point
    before), with the extra driving each costs. One chain start → new → s1 → new → s2 ... gives every leg needed."""
    point = _point(new)
    if point is None:
        raise ValueError("This store has no map location yet, so it cannot be placed on a route")
    stops = [row for row in day if _point(row) is not None]
    start = _point(origin) or point  # no known start: placing the store first costs only new → first stop
    chain: list[Point] = []
    for prev in [start, *(_point(row) for row in stops)]:
        chain += [prev, point]  # type: ignore[list-item]
    legs = drive_times(chain)
    # Points p0 (the start), p1..pn (the stops): legs[2k] = pk → new, legs[2k + 1] = new → p(k+1).
    to_new, from_new = legs[0::2], legs[1::2]
    options = []
    for index in range(len(stops) + 1):
        cost = to_new[index]
        if index < len(stops):
            cost += from_new[index] - (stops[index].get("leg") or 0)
        options.append(InsertOption(
            position=next(i for i, row in enumerate(day) if row is stops[index]) if index < len(stops) else len(day),
            after=stops[index - 1]["name"] if index else "",
            before=stops[index]["name"] if index < len(stops) else "",
            extra_minutes=max(0, round(cost)),
        ))
    if options:
        cheapest = min(options, key=lambda option: (option.extra_minutes, option.position))
        cheapest.best = True
    return options


def reorder_day(stops: list[PlanStop]) -> list[PlanStop]:
    """A day's stops in a fresh visiting order, without moving them to another day (used after a reassign)."""
    by_key = {stop.key: stop for stop in stops}
    return [by_key[row["id"]] for row in optimize_existing_day([plan_row(stop) for stop in stops])]


def last_stop_starts(plan: RoutePlan, stops: list[PlanStop]) -> dict[str, StartLocation]:
    """Where each installer would set off next: their last visited stop of the current day, else the current day's
    start (else the installer's own start). The "Plan next day" dialog defaults to these."""
    current = plan.days[-1]
    result: dict[str, StartLocation] = {}
    for installer in plan.installers:
        start = current.starts.get(installer.name, installer.start)
        visited_today = [
            stop for stop in stops
            if stop.installer == installer.name and stop.day == current.number and stop.visited_screens
            and stop.located
        ]
        if visited_today:
            last = max(visited_today, key=lambda stop: stop.seq)
            address = ", ".join(part for part in (last.addr, last.city, last.state, last.zip) if part)
            assert last.lat is not None and last.lng is not None
            start = StartLocation(address=address or last.store_name or "Last stop", lat=last.lat, lng=last.lng)
        result[installer.name] = start
    return result


# ---- inputs and outputs ---------------------------------------------------------------------------------------


class StoreRef(ApiModel):
    project_id: str = Field(min_length=1, max_length=64)
    stop_uid: str = Field(min_length=1, max_length=64)


class RoutePlanCreate(ApiModel):
    name: str = Field(min_length=1, max_length=200)
    start_date: str = Field(pattern=DATE_PATTERN)
    stops_per_day: int = Field(default=10, ge=1, le=50)
    max_day_hours: float = Field(default=0, ge=0, le=MAX_DAY_HOURS)  # 0 = no limit
    installers: list[PlanInstaller] = Field(min_length=1, max_length=MAX_PLAN_INSTALLERS)
    stores: list[StoreRef] = Field(min_length=1, max_length=MAX_PLAN_STORES)


class RoutePlanUpdate(ApiModel):
    """Plan settings. `installers` replaces the list (names and start locations); `replan` says what to rebuild."""

    name: str | None = Field(default=None, min_length=1, max_length=200)
    stops_per_day: int | None = Field(default=None, ge=1, le=50)
    max_day_hours: float | None = Field(default=None, ge=0, le=MAX_DAY_HOURS)  # 0 clears the limit
    installers: list[PlanInstaller] | None = Field(default=None, min_length=1, max_length=MAX_PLAN_INSTALLERS)
    replan: Replan = Replan.FORECAST
    version: int | None = None


class PlanStoresAdd(ApiModel):
    stores: list[StoreRef] = Field(min_length=1, max_length=MAX_PLAN_STORES)
    replan: Replan = Replan.FORECAST
    version: int | None = None


class Reassign(ApiModel):
    installer: str = Field(min_length=1, max_length=200)
    version: int | None = None


class NextDay(ApiModel):
    """Close the current day and plan the next one. Starts left out default to each installer's last visited stop
    (else today's start); limits left out default to the plan's. The limits apply to this day only: the plan's
    defaults stay as they are."""

    date: str = Field(pattern=DATE_PATTERN)
    starts: dict[str, StartLocation] = Field(default_factory=dict)
    stops_per_day: int | None = Field(default=None, ge=1, le=50)
    max_day_hours: float | None = Field(default=None, ge=0, le=MAX_DAY_HOURS)
    version: int | None = None


class DayLockSet(ApiModel):
    installer: str = Field(min_length=1, max_length=200)
    day: int = Field(ge=1)
    locked: bool
    version: int | None = None


class InsertQuery(ApiModel):
    installer: str = Field(min_length=1, max_length=200)
    day: int = Field(ge=1)
    store: StoreRef


class InsertOptions(ApiModel):
    store_name: str
    options: list[InsertOption]


class DayInsert(InsertQuery):
    """Put a store (from this plan, or free in its project) on an installer's day at `position`. The day keeps this
    order until it is recalculated (never, while it is locked)."""

    position: int = Field(ge=0)
    version: int | None = None


class MoveToNextDay(ApiModel):
    version: int | None = None


class SkippedStore(ApiModel):
    project_id: str
    stop_uid: str
    store_name: str = ""
    reason: str  # "not_found" | "in_another_plan" | "already_in_plan"
    route_plan_id: str = ""


class RoutePlanBundle(ApiModel):
    """The whole plan for the plan page: META, every stop (installer, day, seq order), project names for labels,
    and where each installer would start the next day."""

    plan: RoutePlan
    stops: list[PlanStop]
    project_names: dict[str, str]
    next_starts: dict[str, StartLocation]
    # Live from the stores (plan stops are snapshots): the derived status per plan stop key, for chips and pins.
    store_status: dict[str, str] = Field(default_factory=dict)


class PlanResult(ApiModel):
    bundle: RoutePlanBundle
    skipped: list[SkippedStore] = Field(default_factory=list)


class PlanPreview(ApiModel):
    stops: list[PlanStop]
    skipped: list[SkippedStore] = Field(default_factory=list)


class PoolStore(ApiModel):
    """A store as the cross-project picker lists it."""

    project_id: str
    project_name: str
    uid: str
    external_id: str = ""
    store_name: str = ""
    addr: str = ""
    city: str = ""
    state: str = ""
    zip: str = ""
    lat: float | None = None
    lng: float | None = None
    status: str = ""
    screen_count: int = 0
    pa: str = ""
    dma: str = ""
    route_plan_id: str = ""
