import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, CalendarPlus, Download, Lock, Pencil, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { MapView } from "@/components/map/MapView";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { usePlanMutations, useRoutePlan } from "@/features/planner/api";
import { AddToDayDialog } from "@/features/planner/AddToDayDialog";
import { PlanDayCard } from "@/features/planner/PlanDayCard";
import { AddStoresDialog, EditPlanDialog, NextDayDialog } from "@/features/planner/PlanDialogs";
import { MoveStopDialog } from "@/features/planner/MoveStopDialog";
import { dayLimits, dayLine, fullAddress, groupPlan, planCsv, planPins, planProgress, planStopKey, planSummary, STOP_STATE_LABEL, STOP_STATES, stopState, type StopState } from "@/features/planner/planModel";
import { filenameSlug, installerColor } from "@/features/routes/routeModel";
import { VisitPanel } from "@/features/visits/VisitPanel";
import { downloadText } from "@/lib/download";
import type { PlanStop } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const ALL = "__all__";
const SUMMARY_TONE: Record<StopState, string> = {
  done: "border-emerald-300 bg-emerald-50 text-emerald-800",
  incomplete: "border-amber-300 bg-amber-50 text-amber-800",
  route: "border-sky-300 bg-sky-50 text-sky-800",
};

/** One route plan: installer tabs, day cards (done, today, forecast), map, and the day-to-day actions. */
export function PlanPage() {
  const { planId = "" } = useParams();
  const query = useRoutePlan(planId);
  const mutations = usePlanMutations(planId);
  const [tab, setTab] = useState(ALL);
  const [dialog, setDialog] = useState<"next" | "edit" | "add" | "close" | null>(null);
  const [moving, setMoving] = useState<PlanStop | null>(null);
  // The one day the map shows (click a day's title; again, or the chip's ×, for every day).
  const [pickedDay, setPickedDay] = useState<{ installer: string; day: number } | null>(null);
  // The state whose stores the summary lists (click a count).
  const [listed, setListed] = useState<StopState | null>(null);
  const [removing, setRemoving] = useState<PlanStop | null>(null);
  const [adding, setAdding] = useState<{ installer: string; day: number; forecast: boolean } | null>(null);
  const [opened, setOpened] = useState<PlanStop | null>(null);
  const [selectedPin, setSelectedPin] = useState<string | null>(null);
  const bundle = query.data;
  const installers = useMemo(() => (bundle ? groupPlan(bundle) : []), [bundle]);
  const shown = tab === ALL ? installers : installers.filter((installer) => installer.name === tab);
  const mapStops = useMemo(() => {
    if (!bundle) return [];
    if (pickedDay) return bundle.stops.filter((stop) => stop.installer === pickedDay.installer && stop.day === pickedDay.day).sort((a, b) => a.seq - b.seq);
    return tab === ALL ? bundle.stops : bundle.stops.filter((stop) => stop.installer === tab);
  }, [bundle, tab, pickedDay]);
  const pins = useMemo(() => (bundle ? planPins(bundle, mapStops) : []), [bundle, mapStops]);

  if (query.isPending) return <Card className="p-8 text-center font-mono text-slate-500">Loading plan…</Card>;
  if (query.isError || !bundle) {
    return (
      <Card className="items-center gap-3 p-8 text-center text-rose-700">
        Could not load the plan: {query.error?.message}
        <Button variant="outline" size="sm" asChild>
          <Link to="/planner">Back to plans</Link>
        </Button>
      </Card>
    );
  }

  const { plan } = bundle;
  const active = plan.status === "active";
  const progress = planProgress(plan, bundle.stops);
  const current = plan.days.at(-1)!;
  const names = plan.installers.map((installer) => installer.name);
  // Today's limits, said once when every installer has the same ones.
  const limitsToday = names.map((name) => dayLimits(plan, current.number, name));
  const sameLimits = limitsToday.every((limit) => limit.perDay === limitsToday[0]!.perDay && limit.hours === limitsToday[0]!.hours);
  const todayLimits = limitsToday[0]!;
  const colors = Object.fromEntries(installers.map((installer) => [installer.name, installerColor(names, installer.name)]));

  const pickedView = pickedDay ? installers.find((installer) => installer.name === pickedDay.installer)?.days.find((day) => day.number === pickedDay.day) : undefined;
  const routes = pickedDay && pickedView ? [dayLine(`${pickedDay.installer}|${pickedDay.day}`, colors[pickedDay.installer] ?? "#0f172a", mapStops, pickedView.start, true)] : undefined;
  const labels = pickedDay ? Object.fromEntries(mapStops.map((stop, index) => [planStopKey(stop), String(index + 1)])) : undefined;
  const summary = planSummary(bundle.stops);
  // A closed plan's stores that were never done or marked were simply not visited.
  const stateLabel = (state: StopState) => (state === "route" && !active ? "Not visited" : STOP_STATE_LABEL[state]);

  const run = async (action: () => Promise<unknown>, success: string, fallback: string) => {
    try {
      await action();
      toast.success(success);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : fallback);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Link to="/planner" className="inline-flex items-center gap-1 font-mono text-xs text-slate-500 hover:text-slate-800">
            <ArrowLeft className="size-3" /> All plans
          </Link>
          <h1 className="font-display text-3xl tracking-[2px]">
            {plan.name} {!active && <span className="align-middle font-mono text-xs tracking-normal text-slate-500">(closed)</span>}
          </h1>
          <p className="font-mono text-xs text-slate-600">
            Day {current.number} · {current.date} · {progress.visited} of {bundle.stops.length} stores done · {progress.open} open ·{" "}
            {sameLimits ? `today ${todayLimits.perDay}/day per installer${todayLimits.hours ? `, ≤ ${todayLimits.hours} h driving` : ""}` : "each installer has their own limits today"}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {active && (
            <>
              <Button onClick={() => setDialog("next")}>
                <CalendarPlus /> Plan next day
              </Button>
              <Button variant="outline" onClick={() => setDialog("add")}>
                <Plus /> Add stores
              </Button>
              <Button variant="outline" onClick={() => setDialog("edit")}>
                <Pencil /> Edit plan
              </Button>
            </>
          )}
          <Button variant="outline" onClick={() => downloadText(planCsv(bundle), `${filenameSlug(plan.name)}_plan.csv`)}>
            <Download /> CSV
          </Button>
          {active && (
            <Button variant="ghost" onClick={() => setDialog("close")}>
              <Lock /> Close plan
            </Button>
          )}
        </div>
      </div>

      {/* The plan in numbers; a count lists its stores. A closed plan keeps this as its record. */}
      <Card className="gap-2 p-3" role="region" aria-label="Plan summary">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 font-mono text-xs uppercase tracking-[2px] text-slate-500">Summary</span>
          <span className="rounded-full border bg-white px-3 py-1 font-mono text-xs text-slate-700">
            {installers.length} {installers.length === 1 ? "installer" : "installers"} · {bundle.stops.length} stores · {plan.days.length} {plan.days.length === 1 ? "day" : "days"} started
          </span>
          {STOP_STATES.map((state) => (
            <button
              key={state}
              type="button"
              aria-pressed={listed === state}
              disabled={summary[state] === 0}
              onClick={() => setListed(listed === state ? null : state)}
              className={cn("rounded-full border px-3 py-1 font-mono text-xs uppercase tracking-wider disabled:opacity-40", SUMMARY_TONE[state], listed === state && "ring-2 ring-slate-900 ring-offset-1")}
            >
              {stateLabel(state)} <span className="tabular-nums">{summary[state]}</span>
            </button>
          ))}
        </div>
        {listed && (
          <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border bg-white" aria-label={`${stateLabel(listed)} stores`}>
            {bundle.stops
              .filter((stop) => stopState(stop) === listed)
              .map((stop) => (
                <li key={planStopKey(stop)}>
                  <button type="button" className="flex w-full flex-wrap items-baseline gap-x-3 px-3 py-1.5 text-left text-sm hover:bg-slate-50" onClick={() => setOpened(stop)}>
                    <span className="font-medium text-slate-900">{stop.store_name}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-slate-500">{fullAddress(stop)}</span>
                    <span className="font-mono text-[11px] text-slate-500">
                      {stop.installer} · day {stop.day} · {bundle.project_names[stop.project_id] ?? stop.project_id}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        )}
      </Card>

      <div role="tablist" aria-label="Installers" className="flex flex-wrap gap-1.5">
        {installers.map((installer) => (
          <button
            key={installer.name}
            role="tab"
            aria-selected={tab === installer.name}
            onClick={() => setTab(installer.name)}
            className={cn("flex items-center gap-2 rounded-lg border-2 bg-white px-3 py-1.5 text-sm font-semibold", tab === installer.name && "shadow-sm ring-2 ring-offset-1")}
            style={{ borderColor: installerColor(names, installer.name) }}
          >
            {installer.name}
            <span className="font-mono text-[10px] font-normal text-slate-500">
              {installer.visited}/{installer.total} done · {installer.days.length} days
            </span>
          </button>
        ))}
        <button
          role="tab"
          aria-selected={tab === ALL}
          onClick={() => setTab(ALL)}
          className={cn("ml-auto rounded-lg border-2 bg-white px-3 py-1.5 text-sm font-semibold", tab === ALL && "border-brand")}
        >
          All installers
        </button>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,32%)]">
        <div className="min-w-0 space-y-5">
          {shown.map((installer) => {
            const color = installerColor(names, installer.name);
            return (
              <section key={installer.name} className="space-y-2" aria-label={`${installer.name} plan`}>
                <h2 className="font-display text-2xl tracking-[2px]" style={{ color }}>
                  {installer.name}
                </h2>
                {installer.days.length === 0 ? (
                  <p className="rounded-xl border bg-white p-4 text-sm text-slate-500">No stops for {installer.name}.</p>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                    {installer.days.map((day) => (
                      <PlanDayCard
                        key={`${installer.name}|${day.number}`}
                        bundle={bundle}
                        installer={installer.name}
                        color={color}
                        day={day}
                        active={active}
                        onOpen={setOpened}
                        onMove={setMoving}
                        onMark={(stop, state) =>
                          void run(
                            () => mutations.mark.mutateAsync({ projectId: stop.project_id, uid: stop.stop_uid, body: { outcome: state === "route" ? "" : state } }),
                            `${stop.store_name}: ${STOP_STATE_LABEL[state]}`,
                            "Could not change it",
                          )
                        }
                        onUnpin={(stop) =>
                          void run(
                            () => mutations.mark.mutateAsync({ projectId: stop.project_id, uid: stop.stop_uid, body: { pinned: false } }),
                            `${stop.store_name} can be recalculated again`,
                            "Could not change it",
                          )
                        }
                        onUnlock={() =>
                          void run(
                            () => mutations.setDayLock.mutateAsync({ installer: installer.name, day: day.number, locked: false, version: plan.version }),
                            `Unlocked ${installer.name}, day ${day.number}`,
                            "Could not unlock",
                          )
                        }
                        picked={pickedDay?.installer === installer.name && pickedDay.day === day.number}
                        onPick={() => setPickedDay(pickedDay?.installer === installer.name && pickedDay.day === day.number ? null : { installer: installer.name, day: day.number })}
                        onAdd={() => setAdding({ installer: installer.name, day: day.number, forecast: day.kind === "forecast" })}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
        <div className="flex h-[460px] flex-col gap-1.5 xl:sticky xl:top-20 xl:h-[calc(100vh-7rem)]">
          {pickedDay && (
            <div className="flex items-center gap-2" role="status">
              <span className="font-mono text-[11px] uppercase tracking-wider text-slate-500">Map shows</span>
              <span className="inline-flex items-center gap-1 rounded-full py-0.5 pl-2.5 pr-1 text-xs font-medium text-white" style={{ background: colors[pickedDay.installer] ?? "#0f172a" }}>
                {pickedDay.installer} · Day {pickedDay.day} · {mapStops.length} stops
                <button type="button" aria-label="Show every day on the map" onClick={() => setPickedDay(null)} className="rounded-full p-0.5 hover:bg-white/25">
                  <X size={12} />
                </button>
              </span>
            </div>
          )}
          <MapView
            className="min-h-0 flex-1"
            pins={pins}
            installerColors={colors}
            labels={labels}
            routes={routes}
            selectedId={selectedPin}
            onSelect={(key) => {
              setSelectedPin(key);
              const stop = bundle.stops.find((s) => planStopKey(s) === key);
              if (stop) setOpened(stop);
            }}
          />
        </div>
      </div>

      <NextDayDialog bundle={bundle} open={dialog === "next"} onClose={() => setDialog(null)} />
      <EditPlanDialog bundle={bundle} open={dialog === "edit"} onClose={() => setDialog(null)} />
      <AddStoresDialog bundle={bundle} open={dialog === "add"} onClose={() => setDialog(null)} />
      <AddToDayDialog
        bundle={bundle}
        installer={adding?.installer ?? ""}
        day={adding?.day ?? 1}
        forecast={adding?.forecast ?? false}
        open={adding !== null}
        onClose={() => setAdding(null)}
      />
      <VisitPanel
        projectId={opened?.project_id ?? null}
        stopUid={opened?.stop_uid ?? null}
        planId={plan.id}
        installer={opened?.installer ?? ""}
        visitDate={plan.days.find((day) => day.number === opened?.day)?.date ?? null}
        plan={
          opened && active
            ? {
                // The stop as the plan has it now (it may have been marked since the window opened).
                state: stopState(bundle.stops.find((stop) => planStopKey(stop) === planStopKey(opened)) ?? opened),
              }
            : undefined
        }
        onClose={() => setOpened(null)}
      />
      <ConfirmDialog
        open={dialog === "close"}
        title="Close this plan?"
        confirmLabel="Close plan"
        busy={mutations.close.isPending}
        onCancel={() => setDialog(null)}
        onConfirm={() => void run(() => mutations.close.mutateAsync(), "Plan closed", "Could not close the plan").then(() => setDialog(null))}
      >
        Every store leaves the plan and loses the "in route" marker; {progress.open} open stores can then join another plan. The plan and its visits stay as history.
      </ConfirmDialog>
      <MoveStopDialog bundle={bundle} stop={moving} onClose={() => setMoving(null)} onRemove={setRemoving} />
      <ConfirmDialog
        open={removing !== null}
        title="Remove this store from the plan?"
        confirmLabel="Remove"
        busy={mutations.removeStop.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() =>
          removing &&
          void run(
            () => mutations.removeStop.mutateAsync({ projectId: removing.project_id, uid: removing.stop_uid }),
            `Removed ${removing.store_name}`,
            "Remove failed",
          ).then(() => setRemoving(null))
        }
      >
        <strong>{removing?.store_name}</strong> leaves the plan and can be added to another one.
      </ConfirmDialog>
    </div>
  );
}
