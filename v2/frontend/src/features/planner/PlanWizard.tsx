import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowLeft, ArrowRight, Loader2, Route } from "lucide-react";
import { toast } from "sonner";
import { MapView } from "@/components/map/MapView";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCreatePlan, usePreviewPlan } from "@/features/planner/api";
import { emptyInstaller, InstallerRows, installerProblems, type InstallerDraft } from "@/features/planner/InstallerRows";
import { dayMiles, planStopKey, todayIso } from "@/features/planner/planModel";
import { StorePicker } from "@/features/planner/StorePicker";
import { US_STATE_NAMES } from "@/features/routes/routeModel";
import type { Pin, PlanPreview, PoolStore, RoutePlanCreate, SkippedStore } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const STEPS = ["Stores", "Installers", "Days", "Preview"] as const;

const REASONS: Record<string, string> = {
  not_found: "no longer exists",
  in_another_plan: "is in another plan",
  already_in_plan: "is already in this plan",
};

export function skippedMessage(skipped: SkippedStore[]): string {
  if (!skipped.length) return "";
  const names = skipped.slice(0, 3).map((s) => `${s.store_name || s.stop_uid} ${REASONS[s.reason] ?? s.reason}`);
  return `${skipped.length} not added: ${names.join("; ")}${skipped.length > 3 ? "; …" : ""}`;
}

function defaultName(stores: PoolStore[], date: string): string {
  const states = [...new Set(stores.map((s) => s.state.toUpperCase()).filter(Boolean))].sort();
  const where = states.length === 0 ? "Route" : states.length <= 3 ? states.join(", ") : `${states.length} states`;
  return `${where} · ${date}`;
}

/** Plan a Route: stores from any project → installers and their starts → stops per day and start date → preview. */
export function PlanWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState<Map<string, PoolStore>>(new Map());
  const [installers, setInstallers] = useState<InstallerDraft[]>([emptyInstaller()]);
  const [perDay, setPerDay] = useState(10);
  const [startDate, setStartDate] = useState(todayIso());
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const previewPlan = usePreviewPlan();
  const create = useCreatePlan();

  const stores = useMemo(() => [...selected.values()], [selected]);
  const problems = installerProblems(installers);
  const body = (): RoutePlanCreate => ({
    name: name.trim() || defaultName(stores, startDate),
    start_date: startDate,
    stops_per_day: perDay,
    installers: installers.map((row) => ({ name: row.name.trim(), start: row.start! })),
    stores: stores.map((store) => ({ project_id: store.project_id, stop_uid: store.uid })),
  });
  const canNext = [stores.length > 0, problems.length === 0, perDay >= 1 && perDay <= 50 && Boolean(startDate), true][step];

  const goto = async (next: number) => {
    if (next === 3) {
      try {
        setPreview(await previewPlan.mutateAsync(body()));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Preview failed");
        return;
      }
    }
    setStep(next);
  };

  const submit = async () => {
    try {
      const result = await create.mutateAsync(body());
      const note = skippedMessage(result.skipped);
      toast.success(`Plan created with ${result.bundle.plan.store_count} stores`, note ? { description: note } : undefined);
      navigate(`/planner/${result.bundle.plan.id}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the plan");
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-3xl tracking-[2px]">Plan a route</h1>
        <ol className="flex gap-1.5 font-mono text-[11px]" aria-label="Steps">
          {STEPS.map((label, index) => (
            <li
              key={label}
              aria-current={index === step ? "step" : undefined}
              className={cn("rounded-full border px-3 py-1", index === step ? "border-brand bg-brand text-white" : index < step ? "border-brand text-brand" : "text-slate-400")}
            >
              {index + 1}. {label}
            </li>
          ))}
        </ol>
      </div>

      {step === 0 && <StorePicker selected={selected} onChange={setSelected} />}

      {step === 1 && (
        <Card className="space-y-3 p-5">
          <p className="text-sm text-slate-600">
            Each installer starts from their own location (home or hotel). You can change it every day with "Plan next day".
          </p>
          <InstallerRows rows={installers} onChange={setInstallers} />
          {problems.length > 0 && <p className="text-xs text-amber-700">{problems[0]}</p>}
        </Card>
      )}

      {step === 2 && (
        <Card className="grid gap-4 p-5 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="per-day">Stops per day (each installer)</Label>
            <Input id="per-day" type="number" min={1} max={50} value={perDay} onChange={(e) => setPerDay(Number(e.target.value))} />
            <p className="text-xs text-slate-500">Stores beyond one day roll into the next days.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="start-date">Start date</Label>
            <Input id="start-date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="plan-name">Plan name</Label>
            <Input id="plan-name" placeholder={defaultName(stores, startDate)} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </Card>
      )}

      {step === 3 && preview && <PreviewStep preview={preview} perDay={perDay} installers={installers} />}

      <div className="flex items-center justify-between gap-3 border-t pt-4">
        <Button variant="outline" onClick={() => (step === 0 ? navigate("/planner") : setStep(step - 1))}>
          <ArrowLeft /> {step === 0 ? "Cancel" : "Back"}
        </Button>
        <span className="font-mono text-xs text-slate-500">
          {stores.length} stores · {installers.length} {installers.length === 1 ? "installer" : "installers"} · {perDay}/day
        </span>
        {step < 3 ? (
          <Button onClick={() => void goto(step + 1)} disabled={!canNext || previewPlan.isPending}>
            {previewPlan.isPending && <Loader2 className="animate-spin" />} Next <ArrowRight />
          </Button>
        ) : (
          <Button onClick={() => void submit()} disabled={create.isPending}>
            {create.isPending ? <Loader2 className="animate-spin" /> : <Route />} Create plan
          </Button>
        )}
      </div>
    </div>
  );
}

function PreviewStep({ preview, perDay, installers }: { preview: PlanPreview; perDay: number; installers: InstallerDraft[] }) {
  const rows = installers.map((installer) => {
    const mine = preview.stops.filter((stop) => stop.installer === installer.name.trim());
    const days = [...new Set(mine.map((stop) => stop.day))].sort((a, b) => a - b);
    return {
      name: installer.name.trim(),
      days: days.map((day) => {
        const stops = mine.filter((stop) => stop.day === day).sort((a, b) => a.seq - b.seq);
        return { day, count: stops.length, miles: dayMiles(stops, day === 1 ? installer.start : null) };
      }),
      total: mine.length,
    };
  });
  const states = [...new Set(preview.stops.map((stop) => stop.state.toUpperCase()).filter(Boolean))];
  const pins: Pin[] = preview.stops.flatMap((stop) =>
    stop.lat !== null && stop.lng !== null
      ? [{ uid: planStopKey(stop), lat: stop.lat, lng: stop.lng, status: "Upcoming", store_name: stop.store_name, installer: stop.installer, day: stop.day, route_plan_id: "", visit_state: "none" }]
      : [],
  );
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,40%)]">
      <Card className="space-y-4 p-5">
        <p className="text-sm text-slate-600">
          {preview.stops.length} stores in {states.map((s) => US_STATE_NAMES[s] ?? s).join(", ") || "—"}, at most {perDay} per installer per day.
          Day 1 starts from each installer's start; later days are a forecast that is recalculated every time you plan the next day.
        </p>
        {skippedMessage(preview.skipped) && <p className="text-xs text-amber-700">{skippedMessage(preview.skipped)}</p>}
        {rows.map((row) => (
          <section key={row.name} aria-label={`${row.name} preview`}>
            <h3 className="font-display text-xl tracking-[2px]">
              {row.name} <span className="font-mono text-xs tracking-normal text-slate-500">{row.total} stops · {row.days.length} days</span>
            </h3>
            {row.days.length === 0 ? (
              <p className="text-xs text-slate-500">No stores near this installer's start.</p>
            ) : (
              <ul className="mt-1 flex flex-wrap gap-1.5 font-mono text-[11px]">
                {row.days.map((day) => (
                  <li key={day.day} className="rounded border bg-slate-50 px-2 py-1">
                    Day {day.day}: {day.count} stops · {day.miles} mi
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </Card>
      <MapView className="h-[460px]" pins={pins} />
    </div>
  );
}
