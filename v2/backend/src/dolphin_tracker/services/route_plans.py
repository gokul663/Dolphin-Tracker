"""Route plans (ROUTE-PLANNER §3, §4): stores from any project, installers with their own start, a stops-per-day
cap and day-by-day replanning. Plans are small enough (≤ 2000 stores) to rebuild inside the request.

Rules:
- A store is in at most one active plan (`Stop.route_plan_id`, claimed with a conditional write).
- Days up to the current one have started; later days are a forecast. Visited stops never move.
- "Plan next day" closes the current day: whatever is not visited goes back into the pool, and every open stop is
  laid out again from the new starts, beginning with the new day.
"""
from __future__ import annotations

from collections import defaultdict

from dolphin_tracker.domain.errors import ConflictError, NotFoundError, ValidationFailed
from dolphin_tracker.domain.lists import NameListKind, name_key
from dolphin_tracker.domain.models import PENDING_STATUSES, Page, Stop, now_iso
from dolphin_tracker.domain.route_plans import (
    MAX_PLAN_STORES,
    Assignment,
    DayInsert,
    DayLock,
    DayLockSet,
    DriveTimes,
    InsertOptions,
    InsertQuery,
    MoveToNextDay,
    NextDay,
    PlanDay,
    PlanInstaller,
    PlanPreview,
    PlanResult,
    PlanStatus,
    PlanStop,
    PlanStopState,
    PlanStoresAdd,
    Reassign,
    Replan,
    RoutePlan,
    RoutePlanBundle,
    RoutePlanCreate,
    RoutePlanUpdate,
    SkippedStore,
    StartLocation,
    StoreRef,
    assign,
    chain_legs,
    check_installers,
    estimate_leg_minutes,
    insertion_options,
    last_stop_starts,
    plan_stop_key,
    reorder_day,
    skip_locked,
)
from dolphin_tracker.repositories.projects import ProjectRepository
from dolphin_tracker.repositories.route_plans import RoutePlanRepository
from dolphin_tracker.repositories.stores import StoreRepository
from dolphin_tracker.services.lists import ListService


def snapshot(project_id: str, stop: Stop, added_at: str) -> PlanStop:
    return PlanStop(
        project_id=project_id, stop_uid=stop.uid, external_id=stop.external_id, store_name=stop.store_name,
        addr=stop.addr, city=stop.city, state=stop.state, zip=stop.zip, lat=stop.lat, lng=stop.lng,
        screen_ids=[screen.id for screen in stop.screens], added_at=added_at,
    )


def order(stops: list[PlanStop]) -> list[PlanStop]:
    return sorted(stops, key=lambda s: (s.installer, s.day, s.seq, s.store_name, s.key))


class RoutePlanService:
    def __init__(
        self,
        plans: RoutePlanRepository,
        stores: StoreRepository,
        projects: ProjectRepository,
        lists: ListService,
        drive_times: DriveTimes = estimate_leg_minutes,
    ) -> None:
        self._plans = plans
        self._stores = stores
        self._projects = projects
        self._lists = lists
        self._drive_times = drive_times  # Google driving times in the app; the straight-line estimate otherwise

    # ---- reads ------------------------------------------------------------------------------------------------

    def list(self, status: PlanStatus, *, limit: int = 50, cursor: str | None = None) -> Page[RoutePlan]:
        return self._plans.list(status, limit=limit, cursor=cursor)

    def _plan(self, plan_id: str) -> RoutePlan:
        plan = self._plans.get(plan_id)
        if plan is None:
            raise NotFoundError(f"Route plan {plan_id} not found")
        return plan

    def _active(self, plan_id: str, version: int | None = None) -> RoutePlan:
        plan = self._plan(plan_id)
        if plan.status != PlanStatus.ACTIVE:
            raise ConflictError("This plan is closed")
        if version is not None and version != plan.version:
            raise ConflictError("The plan was changed by someone else; reload it and try again")
        return plan

    def _project_names(self, project_ids: set[str]) -> dict[str, str]:
        names = {}
        for project_id in sorted(project_ids):
            project = self._projects.get(project_id)
            names[project_id] = project.name if project else "(deleted project)"
        return names

    def _statuses(self, stops: list[PlanStop]) -> dict[str, str]:
        wanted = {stop.key for stop in stops}
        statuses = {}
        for project_id in sorted({stop.project_id for stop in stops}):
            for item in self._stores.list_projected(project_id, ("uid", "status")):
                key = plan_stop_key(project_id, item["uid"])
                if key in wanted:
                    statuses[key] = item.get("status") or "Upcoming"
        return statuses

    def _bundle(self, plan: RoutePlan, stops: list[PlanStop]) -> RoutePlanBundle:
        return RoutePlanBundle(
            plan=plan,
            stops=order(stops),
            project_names=self._project_names({stop.project_id for stop in stops}),
            next_starts=last_stop_starts(plan, stops),
            store_status=self._statuses(stops),
        )

    def bundle(self, plan_id: str) -> RoutePlanBundle:
        plan = self._plan(plan_id)
        return self._bundle(plan, self._plans.list_stops(plan_id))

    # ---- loading stores ---------------------------------------------------------------------------------------

    def _load(self, refs: list[StoreRef], plan_id: str = "") -> tuple[list[tuple[str, Stop]], list[SkippedStore]]:
        """The stores behind `refs` (deduplicated), and the ones that cannot join: gone, or in a plan already."""
        wanted: dict[str, set[str]] = defaultdict(set)
        for ref in refs:
            wanted[ref.project_id].add(ref.stop_uid)
        found: list[tuple[str, Stop]] = []
        skipped: list[SkippedStore] = []
        for project_id, uids in wanted.items():
            stops = {stop.uid: stop for stop in self._stores.list_all(project_id)} if self._projects.get(
                project_id) else {}
            for uid in sorted(uids):
                stop = stops.get(uid)
                if stop is None:
                    skipped.append(SkippedStore(project_id=project_id, stop_uid=uid, reason="not_found"))
                elif stop.route_plan_id:
                    reason = "already_in_plan" if stop.route_plan_id == plan_id else "in_another_plan"
                    skipped.append(SkippedStore(project_id=project_id, stop_uid=uid, store_name=stop.store_name,
                                                reason=reason, route_plan_id=stop.route_plan_id))
                else:
                    found.append((project_id, stop))
        if len(found) > MAX_PLAN_STORES:
            raise ValidationFailed(f"A plan holds at most {MAX_PLAN_STORES} stores")
        return found, skipped

    def _claim(self, plan_id: str, found: list[tuple[str, Stop]], at: str) -> tuple[list[PlanStop], list[SkippedStore]]:
        """Claim the stores for the plan. A store another plan claimed since `_load` is reported, not added."""
        by_project: dict[str, list[Stop]] = defaultdict(list)
        for project_id, stop in found:
            by_project[project_id].append(stop)
        claimed: list[PlanStop] = []
        lost: list[SkippedStore] = []
        for project_id, stops in by_project.items():
            won = set(self._stores.claim_for_plan(project_id, [stop.uid for stop in stops], plan_id, at))
            for stop in stops:
                if stop.uid in won:
                    claimed.append(snapshot(project_id, stop, at))
                else:
                    lost.append(SkippedStore(project_id=project_id, stop_uid=stop.uid, store_name=stop.store_name,
                                             reason="in_another_plan"))
        return claimed, lost

    def _release(self, plan_id: str, stops: list[PlanStop]) -> None:
        by_project: dict[str, list[str]] = defaultdict(list)
        for stop in stops:
            by_project[stop.project_id].append(stop.stop_uid)
        for project_id, uids in by_project.items():
            self._stores.release_from_plan(project_id, uids, plan_id)

    # ---- building ---------------------------------------------------------------------------------------------

    @staticmethod
    def _apply(stops: list[PlanStop], assignment: Assignment) -> list[tuple[str, dict]]:
        """Set the new assignment on `stops` in place; return the writes for the ones that changed."""
        changes = []
        for stop in stops:
            if stop.key not in assignment:
                continue
            installer, day, seq, minutes = assignment[stop.key]
            if (stop.installer, stop.day, stop.seq, stop.drive_minutes) != (installer, day, seq, minutes):
                stop.installer, stop.day, stop.seq, stop.drive_minutes = installer, day, seq, minutes
                changes.append((stop.key, {"installer": installer, "day": day, "seq": seq, "drive_minutes": minutes}))
        return changes

    def _assign(
        self, stops: list[PlanStop], starts: dict[str, StartLocation], per_day: int, first_day: int, hours: float
    ) -> Assignment:
        return assign(stops, starts, per_day, first_day, max_day_hours=hours, drive_times=self._drive_times)

    @staticmethod
    def _forecast_starts(plan: RoutePlan, stops: list[PlanStop]) -> dict[str, StartLocation]:
        """Where the forecast picks up: the end of each installer's route today, else today's start."""
        current = plan.days[-1]
        starts = {}
        for installer in plan.installers:
            today = [s for s in stops if s.installer == installer.name and s.day == current.number and s.located]
            start = current.starts.get(installer.name, installer.start)
            if today:
                last = max(today, key=lambda s: s.seq)
                assert last.lat is not None and last.lng is not None
                start = StartLocation(address=last.store_name or "Last stop", lat=last.lat, lng=last.lng)
            starts[installer.name] = start
        return starts

    def _replan(self, plan: RoutePlan, stops: list[PlanStop], scope: Replan) -> list[tuple[str, dict]]:
        """Lay the open stops out again. FORECAST keeps today's routes; TODAY rebuilds them too."""
        if scope == Replan.NONE:
            return []
        current = plan.days[-1]
        locked = plan.locked()
        open_stops = [stop for stop in stops if stop.state_value == PlanStopState.OPEN
                      and (stop.installer, stop.day) not in locked]
        if scope == Replan.TODAY:
            pool = open_stops
            starts = {i.name: current.starts.get(i.name, i.start) for i in plan.installers}
            first_day = current.number
            per_day, hours = plan.limits(current)  # today keeps the limits it was planned with
        else:
            pool = [stop for stop in open_stops if stop.day > current.number or stop.day == 0]
            starts = self._forecast_starts(plan, stops)
            first_day = current.number + 1
            per_day, hours = plan.limits()  # days not started yet: the plan's defaults
        return self._apply(pool, skip_locked(self._assign(pool, starts, per_day, first_day, hours), locked))

    def _write(self, plan_id: str, changes: list[tuple[str, dict]]) -> None:
        self._plans.update_assignments(plan_id, changes)

    def _remember_installers(self, installers: list[PlanInstaller]) -> None:
        for installer in installers:
            self._lists.remember(NameListKind.INSTALLERS, installer.name)

    # ---- writes -----------------------------------------------------------------------------------------------

    def preview(self, body: RoutePlanCreate) -> PlanPreview:
        """The days a new plan would get, without saving or claiming anything."""
        self._check_installers(body.installers)
        found, skipped = self._load(body.stores)
        at = now_iso()
        stops = [snapshot(project_id, stop, at) for project_id, stop in found]
        starts = {installer.name: installer.start for installer in body.installers}
        self._apply(stops, self._assign(stops, starts, body.stops_per_day, 1, body.max_day_hours))
        return PlanPreview(stops=order(stops), skipped=skipped)

    @staticmethod
    def _check_installers(installers: list[PlanInstaller]) -> None:
        try:
            check_installers(installers)
        except ValueError as exc:
            raise ValidationFailed(str(exc)) from exc

    def create(self, body: RoutePlanCreate) -> PlanResult:
        self._check_installers(body.installers)
        found, skipped = self._load(body.stores)
        if not found:
            raise ValidationFailed("None of these stores can join a plan", skipped=[s.model_dump() for s in skipped])
        plan = RoutePlan(
            name=body.name.strip(),
            stops_per_day=body.stops_per_day,
            max_day_hours=body.max_day_hours,
            installers=body.installers,
            days=[PlanDay(number=1, date=body.start_date,
                          starts={installer.name: installer.start for installer in body.installers})],
        )
        at = now_iso()
        stops, lost = self._claim(plan.id, found, at)
        if not stops:
            raise ConflictError("Every store was claimed by another plan meanwhile")
        try:
            self._apply(stops, self._assign(stops, plan.days[0].starts, plan.stops_per_day, 1, plan.max_day_hours))
            plan = plan.model_copy(update={"store_count": len(stops)})
            self._plans.put(plan)
            self._plans.put_stops(plan.id, stops)
        except Exception:
            self._release(plan.id, stops)
            raise
        self._remember_installers(plan.installers)
        return PlanResult(bundle=self._bundle(plan, stops), skipped=[*skipped, *lost])

    def update(self, plan_id: str, body: RoutePlanUpdate) -> RoutePlanBundle:
        plan = self._active(plan_id, body.version)
        stops = self._plans.list_stops(plan_id)
        changes: dict = {}
        if body.name is not None:
            changes["name"] = body.name.strip()
        if body.stops_per_day is not None:
            changes["stops_per_day"] = body.stops_per_day
        if body.max_day_hours is not None:
            changes["max_day_hours"] = body.max_day_hours
        if body.installers is not None:
            self._check_installers(body.installers)
            kept = {name_key(i.name) for i in body.installers}
            if body.replan != Replan.TODAY:
                stranded = sorted({
                    stop.installer for stop in stops
                    if stop.state_value == PlanStopState.OPEN and stop.day <= plan.current_day
                    and name_key(stop.installer) not in kept
                })
                if stranded:
                    raise ValidationFailed(
                        f"{', '.join(stranded)} still has stops today. Replan today to hand them to someone else."
                    )
            changes["installers"] = [i.model_dump() for i in body.installers]
        plan = self._plans.update(plan_id, changes, expected_version=plan.version)
        self._write(plan_id, self._replan(plan, stops, body.replan))
        if body.installers is not None:
            self._remember_installers(body.installers)
        return self._bundle(plan, stops)

    def add_stores(self, plan_id: str, body: PlanStoresAdd) -> PlanResult:
        plan = self._active(plan_id, body.version)
        found, skipped = self._load(body.stores, plan_id)
        at = now_iso()
        added, lost = self._claim(plan_id, found, at)
        existing = self._plans.list_stops(plan_id)
        try:
            self._plans.put_stops(plan_id, added)  # day 0: placed by the replan below
            plan = self._plans.update(plan_id, {"store_count": len(existing) + len(added)},
                                      expected_version=plan.version)
        except Exception:
            self._release(plan_id, added)
            for stop in added:
                self._plans.delete_stop(plan_id, stop.key)
            raise
        stops = [*existing, *added]
        self._write(plan_id, self._replan(plan, stops, Replan.TODAY if body.replan == Replan.TODAY else
                                          Replan.FORECAST))
        return PlanResult(bundle=self._bundle(plan, stops), skipped=[*skipped, *lost])

    def _find(self, plan_id: str, project_id: str, stop_uid: str) -> PlanStop:
        stop = self._plans.get_stop(plan_id, plan_stop_key(project_id, stop_uid))
        if stop is None:
            raise NotFoundError("That store is not in this plan")
        return stop

    def remove_stop(self, plan_id: str, project_id: str, stop_uid: str) -> RoutePlanBundle:
        plan = self._active(plan_id)
        stop = self._find(plan_id, project_id, stop_uid)
        if stop.state_value == PlanStopState.VISITED:
            raise ConflictError("A visited store stays in the plan's history")
        self._plans.delete_stop(plan_id, stop.key)
        self._release(plan_id, [stop])
        stops = self._plans.list_stops(plan_id)
        locks = [lock.model_dump() for lock in self._live_locks(plan, stops)]  # an emptied locked day unlocks
        plan = self._plans.update(plan_id, {"store_count": len(stops), "locked_days": locks})
        same_day = [s for s in stops if (s.installer, s.day) == (stop.installer, stop.day)]
        self._write(plan_id, self._reseq(plan, stops, same_day))
        return self._bundle(plan, stops)

    @staticmethod
    def _day_origin(plan: RoutePlan, stops: list[PlanStop], installer: str, day: int) -> dict:
        """Where `installer` sets off on `day`: the start recorded for a started day, else near the previous day's
        last stop (the hotel), else the installer's own start."""
        started = next((d for d in plan.days if d.number == day), None)
        if started and installer in started.starts:
            start = started.starts[installer]
            return {"lat": start.lat, "lng": start.lng}
        before = [s for s in stops if s.installer == installer and s.day == day - 1 and s.located]
        if before:
            last = max(before, key=lambda s: s.seq)
            return {"lat": last.lat, "lng": last.lng}
        own = next((i.start for i in plan.installers if i.name == installer), None)
        return {"lat": own.lat, "lng": own.lng} if own else {}

    def _reseq(
        self, plan: RoutePlan, stops: list[PlanStop], day: list[PlanStop], *, keep_order: bool = False
    ) -> list[tuple[str, dict]]:
        """A day's stops in visiting order, with their driving minutes from the day's start. The order is `day` as
        given with `keep_order`, the current one on a locked day, else a fresh one."""
        if not day:
            return []
        if keep_order:
            ordered = day
        elif (day[0].installer, day[0].day) in plan.locked():
            ordered = sorted(day, key=lambda s: s.seq)
        else:
            ordered = reorder_day(day)
        origin = self._day_origin(plan, stops, ordered[0].installer, ordered[0].day)
        legs = chain_legs(origin, [{"id": s.key, "lat": s.lat, "lng": s.lng} for s in ordered], self._drive_times)
        changes = []
        for seq, stop in enumerate(ordered):
            change: dict = {}
            if stop.seq != seq:
                stop.seq = change["seq"] = seq
            if stop.drive_minutes != legs[stop.key]:
                stop.drive_minutes = change["drive_minutes"] = legs[stop.key]
            if change:
                changes.append((stop.key, change))
        return changes

    # ---- day editing ------------------------------------------------------------------------------------------

    def set_lock(self, plan_id: str, body: DayLockSet) -> RoutePlanBundle:
        plan = self._active(plan_id, body.version)
        installer = self._installer(plan, body.installer)
        locks = [lock for lock in plan.locked_days if (lock.installer, lock.day) != (installer, body.day)]
        if body.locked:
            locks.append(DayLock(installer=installer, day=body.day))
        plan = self._plans.update(plan_id, {"locked_days": [lock.model_dump() for lock in locks]},
                                  expected_version=plan.version)
        return self._bundle(plan, self._plans.list_stops(plan_id))

    @staticmethod
    def _installer(plan: RoutePlan, name: str) -> str:
        found = next((i.name for i in plan.installers if name_key(i.name) == name_key(name)), None)
        if found is None:
            raise NotFoundError(f"{name} is not an installer on this plan")
        return found

    def _candidate(self, plan_id: str, ref: StoreRef, stops: list[PlanStop]) -> tuple[PlanStop, bool]:
        """The store to place: (its plan stop, True) when it is in this plan, else a snapshot of the free store."""
        key = plan_stop_key(ref.project_id, ref.stop_uid)
        inside = next((stop for stop in stops if stop.key == key), None)
        if inside is not None:
            if inside.state_value == PlanStopState.VISITED:
                raise ConflictError("A visited store stays where it was visited")
            return inside, True
        found, skipped = self._load([ref], plan_id)
        if not found:
            reason = skipped[0].reason if skipped else "not_found"
            raise ConflictError("That store is in another plan" if reason == "in_another_plan" else "Store not found")
        project_id, stop = found[0]
        return snapshot(project_id, stop, now_iso()), False

    @staticmethod
    def _day(stops: list[PlanStop], installer: str, day: int, without: str = "") -> list[PlanStop]:
        return sorted((s for s in stops if s.installer == installer and s.day == day and s.key != without),
                      key=lambda s: s.seq)

    def insert_options(self, plan_id: str, body: InsertQuery) -> InsertOptions:
        plan = self._plan(plan_id)
        installer = self._installer(plan, body.installer)
        stops = self._plans.list_stops(plan_id)
        store, _ = self._candidate(plan_id, body.store, stops)
        options = self._options(plan, stops, installer, body.day, store)
        return InsertOptions(store_name=store.store_name, options=options)

    def _options(self, plan: RoutePlan, stops: list[PlanStop], installer: str, day: int, store: PlanStop):
        rows = [{"name": s.store_name, "lat": s.lat, "lng": s.lng, "leg": s.drive_minutes}
                for s in self._day(stops, installer, day, without=store.key)]
        others = [s for s in stops if s.key != store.key]
        try:
            return insertion_options(self._day_origin(plan, others, installer, day),
                                     rows, {"lat": store.lat, "lng": store.lng}, self._drive_times)
        except ValueError as exc:
            raise ValidationFailed(str(exc)) from exc

    def insert(self, plan_id: str, body: DayInsert) -> RoutePlanBundle:
        plan = self._active(plan_id, body.version)
        installer = self._installer(plan, body.installer)
        if body.day < plan.current_day:
            raise ValidationFailed(f"Day {body.day} is over; add to day {plan.current_day} or later")
        stops = self._plans.list_stops(plan_id)
        store, inside = self._candidate(plan_id, body.store, stops)
        return self._place(plan, stops, store, inside, installer, body.day, body.position)

    def move_to_next_day(self, plan_id: str, project_id: str, stop_uid: str, body: MoveToNextDay) -> RoutePlanBundle:
        """Take an open store off its day and put it on the installer's next day, where it adds the least driving."""
        plan = self._active(plan_id, body.version)
        stops = self._plans.list_stops(plan_id)
        store, _ = self._candidate(plan_id, StoreRef(project_id=project_id, stop_uid=stop_uid), stops)
        target = max(store.day, plan.current_day) + 1
        options = self._options(plan, stops, store.installer, target, store) if store.located else []
        best = next((o.position for o in options if o.best), len(self._day(stops, store.installer, target)))
        return self._place(plan, stops, store, True, store.installer, target, best)

    def _place(self, plan: RoutePlan, stops: list[PlanStop], store: PlanStop, inside: bool, installer: str,
               day: int, position: int) -> RoutePlanBundle:
        source = (store.installer, store.day) if inside else None
        target = self._day(stops, installer, day, without=store.key)
        position = min(position, len(target))
        if not inside:
            free = self._stores.get(store.project_id, store.stop_uid)
            claimed, _ = self._claim(plan.id, [(store.project_id, free)], now_iso()) if free else ([], [])
            if not claimed:
                raise ConflictError("That store was just claimed by another plan")
            store = claimed[0]
            stops.append(store)
        store.installer, store.day, store.seq = installer, day, -1  # -1: always rewritten below
        ordered = [*target[:position], store, *target[position:]]
        merged: dict[str, dict] = {}
        for key, change in self._reseq(plan, stops, ordered, keep_order=True):
            merged.setdefault(key, {}).update(change)
        if source and source != (installer, day):
            for key, change in self._reseq(plan, stops, self._day(stops, *source), keep_order=True):
                merged.setdefault(key, {}).update(change)
        merged.setdefault(store.key, {}).update({"installer": installer, "day": day, "seq": store.seq,
                                                 "drive_minutes": store.drive_minutes})
        changes = list(merged.items())
        if inside:
            self._write(plan.id, changes)
        else:
            try:
                self._plans.put_stops(plan.id, [store])
                self._write(plan.id, [c for c in changes if c[0] != store.key])
            except Exception:
                self._release(plan.id, [store])
                raise
        update: dict = {"locked_days": [lock.model_dump() for lock in self._live_locks(plan, stops)]}
        if not inside:
            update["store_count"] = len(stops)
        plan = self._plans.update(plan.id, update, expected_version=plan.version)  # bumps the version
        return self._bundle(plan, stops)

    @staticmethod
    def _live_locks(plan: RoutePlan, stops: list[PlanStop]) -> list[DayLock]:
        """Locks on days that still have stores (an emptied day leaves no gap behind)."""
        used = {(s.installer, s.day) for s in stops}
        return [lock for lock in plan.locked_days if (lock.installer, lock.day) in used]

    def reassign(self, plan_id: str, project_id: str, stop_uid: str, body: Reassign) -> RoutePlanBundle:
        """Move one open stop to another installer on the same day; both days are reordered."""
        plan = self._active(plan_id, body.version)
        target = next((i.name for i in plan.installers if name_key(i.name) == name_key(body.installer)), None)
        if target is None:
            raise NotFoundError(f"{body.installer} is not an installer on this plan")
        moved = self._find(plan_id, project_id, stop_uid)
        if moved.state_value == PlanStopState.VISITED:
            raise ConflictError("A visited store cannot be reassigned")
        stops = self._plans.list_stops(plan_id)
        source = moved.installer
        for stop in stops:
            if stop.key == moved.key:
                stop.installer = target
        changes = [(moved.key, {"installer": target})]
        for name in {source, target}:
            day = [s for s in stops if s.installer == name and s.day == moved.day]
            changes.extend(self._reseq(plan, stops, day))
        self._write(plan_id, changes)
        plan = self._plans.update(plan_id, {}, expected_version=plan.version)  # bumps the version
        return self._bundle(plan, stops)

    def next_day(self, plan_id: str, body: NextDay) -> RoutePlanBundle:
        plan = self._active(plan_id, body.version)
        current = plan.days[-1]
        if body.date <= current.date:
            raise ValidationFailed(f"The next day must be after {current.date}", fields={"date": "Too early"})
        unknown = sorted(set(body.starts) - set(plan.installer_names()))
        if unknown:
            raise ValidationFailed(f"Not on this plan: {', '.join(unknown)}")
        stops = self._plans.list_stops(plan_id)
        defaults = last_stop_starts(plan, stops)
        starts = {name: body.starts.get(name, defaults[name]) for name in plan.installer_names()}
        day = PlanDay(number=current.number + 1, date=body.date, starts=starts,
                      stops_per_day=body.stops_per_day, max_day_hours=body.max_day_hours)
        per_day, hours = plan.limits(day)
        plan = self._plans.update(
            plan_id, {"days": [*(d.model_dump() for d in plan.days), day.model_dump()]}, expected_version=plan.version
        )
        locked = {(installer, number) for installer, number in plan.locked() if number >= day.number}
        pool = [stop for stop in stops
                if stop.state_value == PlanStopState.OPEN and (stop.installer, stop.day) not in locked]
        assignment = skip_locked(self._assign(pool, starts, per_day, day.number, hours), locked)
        self._write(plan_id, self._apply(pool, assignment))
        return self._bundle(plan, stops)

    def close(self, plan_id: str) -> RoutePlanBundle:
        """Stop working the plan: every store is released (it keeps `last_planned_at`); the plan stays as history."""
        plan = self._active(plan_id)
        stops = self._plans.list_stops(plan_id)
        self._release(plan_id, stops)
        plan = self._plans.update(plan_id, {"status": PlanStatus.CLOSED.value, "closed_at": now_iso()})
        return self._bundle(plan, stops)

    # ---- moving project routes into plans (RP8) ----------------------------------------------------------------

    def import_project_routes(self, project_id: str, start_date: str, *, dry_run: bool = False) -> PlanResult | None:
        """Turn a project's per-project routes into an active plan, keeping each store's installer, day order and
        visiting order. Only routed stores that still need a visit move; each installer starts from their first
        stop. Stores already in a plan are reported, not moved. None when the project has nothing routed."""
        project = self._projects.get(project_id)
        if project is None:
            raise NotFoundError(f"Project {project_id} not found")
        routed = [
            stop for stop in self._stores.list_all(project_id)
            if stop.installer and stop.status in PENDING_STATUSES
        ]
        if not routed:
            return None
        names = sorted({stop.installer for stop in routed}, key=lambda n: (n not in project.installers, n))
        installers = []
        for name in names:
            mine = sorted((s for s in routed if s.installer == name), key=lambda s: (s.day, s.seq))
            first = next((s for s in mine if s.lat is not None and s.lng is not None), None)
            if first is None:
                continue  # nothing to start from; those stores stay out of the plan
            assert first.lat is not None and first.lng is not None
            address = ", ".join(part for part in (first.addr, first.city, first.state, first.zip) if part)
            installers.append(PlanInstaller(name=name, start=StartLocation(
                address=address or first.store_name, lat=first.lat, lng=first.lng)))
        if not installers:
            return None
        kept = {i.name for i in installers}
        plan = RoutePlan(
            name=f"{project.name} (from project routes)",
            stops_per_day=project.stops_per_day,
            installers=installers,
            days=[PlanDay(number=1, date=start_date, starts={i.name: i.start for i in installers})],
        )
        at = now_iso()
        candidates = [stop for stop in routed if stop.installer in kept and not stop.route_plan_id]
        skipped = [
            SkippedStore(project_id=project_id, stop_uid=stop.uid, store_name=stop.store_name,
                         reason="in_another_plan", route_plan_id=stop.route_plan_id)
            for stop in routed if stop.route_plan_id
        ]
        # Day numbers compact to 1, 2, 3, ... per installer, in the project's order.
        layout: dict[str, tuple[str, int, int]] = {}
        for name in kept:
            days = sorted({s.day for s in candidates if s.installer == name})
            for number, day in enumerate(days, start=1):
                ordered = sorted((s for s in candidates if s.installer == name and s.day == day), key=lambda s: s.seq)
                for seq, stop in enumerate(ordered):
                    layout[stop.uid] = (name, number, seq)
        if dry_run:
            stops = [snapshot(project_id, stop, at) for stop in candidates]
            for stop in stops:
                stop.installer, stop.day, stop.seq = layout[stop.stop_uid]
            plan = plan.model_copy(update={"store_count": len(stops)})
            return PlanResult(bundle=self._bundle(plan, stops), skipped=skipped)
        stops, lost = self._claim(plan.id, [(project_id, stop) for stop in candidates], at)
        for stop in stops:
            stop.installer, stop.day, stop.seq = layout[stop.stop_uid]
        if not stops:
            return PlanResult(bundle=self._bundle(plan, []), skipped=[*skipped, *lost])
        try:
            plan = plan.model_copy(update={"store_count": len(stops)})
            self._plans.put(plan)
            self._plans.put_stops(plan.id, stops)
        except Exception:
            self._release(plan.id, stops)
            raise
        self._remember_installers(plan.installers)
        return PlanResult(bundle=self._bundle(plan, stops), skipped=[*skipped, *lost])

    # ---- visits -----------------------------------------------------------------------------------------------

    def stop_day(self, plan_id: str, project_id: str, stop_uid: str) -> int | None:
        """The day the store is on in that plan, or None when it is not in the plan."""
        stop = self._plans.get_stop(plan_id, plan_stop_key(project_id, stop_uid))
        return stop.day if stop else None

    def record_visit(self, plan_id: str, project_id: str, stop_uid: str, screen_id: str) -> None:
        self._plans.record_visit(plan_id, plan_stop_key(project_id, stop_uid), screen_id)
