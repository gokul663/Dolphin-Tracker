import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, CalendarPlus, Download, Lock, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { MapView } from "@/components/map/MapView";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { usePlanMutations, useRoutePlan } from "@/features/planner/api";
import { AddToDayDialog } from "@/features/planner/AddToDayDialog";
import { PlanDayCard } from "@/features/planner/PlanDayCard";
import { AddStoresDialog, EditPlanDialog, NextDayDialog } from "@/features/planner/PlanDialogs";
import { dayLimits, groupPlan, planCsv, planPins, planProgress, planStopKey } from "@/features/planner/planModel";
import { filenameSlug, installerColor } from "@/features/routes/routeModel";
import { VisitPanel } from "@/features/visits/VisitPanel";
import { downloadText } from "@/lib/download";
import type { PlanStop } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const ALL = "__all__";

/** One route plan: installer tabs, day cards (done, today, forecast), map, and the day-to-day actions. */
export function PlanPage() {
  const { planId = "" } = useParams();
  const query = useRoutePlan(planId);
  const mutations = usePlanMutations(planId);
  const [tab, setTab] = useState(ALL);
  const [dialog, setDialog] = useState<"next" | "edit" | "add" | "close" | null>(null);
  const [moving, setMoving] = useState<{ stop: PlanStop; to: string } | null>(null);
  const [removing, setRemoving] = useState<PlanStop | null>(null);
  const [adding, setAdding] = useState<{ installer: string; day: number; forecast: boolean } | null>(null);
  const [opened, setOpened] = useState<PlanStop | null>(null);
  const [selectedPin, setSelectedPin] = useState<string | null>(null);
  const bundle = query.data;
  const installers = useMemo(() => (bundle ? groupPlan(bundle) : []), [bundle]);
  const shown = tab === ALL ? installers : installers.filter((installer) => installer.name === tab);
  const pins = useMemo(
    () => (bundle ? planPins(bundle, tab === ALL ? bundle.stops : bundle.stops.filter((stop) => stop.installer === tab)) : []),
    [bundle, tab],
  );

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
  const todayLimits = dayLimits(plan, current.number);
  const names = plan.installers.map((installer) => installer.name);

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
            Day {current.number} · {current.date} · {progress.visited} of {bundle.stops.length} stores visited · {progress.open} open · today {todayLimits.perDay}/day
            per installer{todayLimits.hours ? `, ≤ ${todayLimits.hours} h driving` : ""}
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
              {installer.visited}/{installer.total} visited · {installer.days.length} days
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
                        onReassign={(stop, to) => setMoving({ stop, to })}
                        onRemove={setRemoving}
                        onMoveNext={(stop) =>
                          void run(
                            () => mutations.moveToNextDay.mutateAsync({ projectId: stop.project_id, uid: stop.stop_uid, version: plan.version }),
                            `Moved ${stop.store_name} to the next day`,
                            "Move failed",
                          )
                        }
                        onToggleLock={(locked) =>
                          void run(
                            () => mutations.setDayLock.mutateAsync({ installer: installer.name, day: day.number, locked, version: plan.version }),
                            locked ? `Locked ${installer.name}, day ${day.number}` : `Unlocked ${installer.name}, day ${day.number}`,
                            "Could not change the lock",
                          )
                        }
                        onAdd={() => setAdding({ installer: installer.name, day: day.number, forecast: day.kind === "forecast" })}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
        <MapView
          className="h-[420px] xl:sticky xl:top-20 xl:h-[calc(100vh-7rem)]"
          pins={pins}
          selectedId={selectedPin}
          onSelect={(key) => {
            setSelectedPin(key);
            const stop = bundle.stops.find((s) => planStopKey(s) === key);
            if (stop) setOpened(stop);
          }}
        />
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
      <ConfirmDialog
        open={moving !== null}
        title="Reassign this store?"
        confirmLabel="Reassign"
        busy={mutations.reassign.isPending}
        onCancel={() => setMoving(null)}
        onConfirm={() =>
          moving &&
          void run(
            () => mutations.reassign.mutateAsync({ projectId: moving.stop.project_id, uid: moving.stop.stop_uid, installer: moving.to, version: plan.version }),
            `Moved ${moving.stop.store_name} to ${moving.to}`,
            "Reassign failed",
          ).then(() => setMoving(null))
        }
      >
        Move <strong>{moving?.stop.store_name}</strong> from <strong>{moving?.stop.installer}</strong> to <strong>{moving?.to}</strong> on day {moving?.stop.day}.
      </ConfirmDialog>
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
