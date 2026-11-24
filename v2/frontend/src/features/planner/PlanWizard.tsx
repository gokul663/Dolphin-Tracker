import { useCan } from "@/lib/auth/me";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowLeft, ArrowRight, Loader2, Route } from "lucide-react";
import { toast } from "sonner";
import { MapView } from "@/components/map/MapView";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCreatePlan, usePreviewPlan } from "@/features/planner/api";
import { firstStartDate, installerBody, InstallerRows, installerProblems, type InstallerDraft } from "@/features/planner/InstallerRows";
import { dayDriveMinutes, dayLine, dayMiles, formatDuration, fullAddress, parseMaxHours, planStopKey } from "@/features/planner/planModel";
import { StorePicker } from "@/features/planner/StorePicker";
import { installerColor, US_STATE_NAMES } from "@/features/routes/routeModel";
import type { Pin, PlanPreview, PoolStore, RoutePlanCreate, SkippedStore } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const STEPS = ["Stores", "Installers", "Preview"] as const;

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
  const canManage = useCan("routes.manage");
  if (!canManage) {
    return (
      <div className="rounded-xl border bg-white p-8 text-center text-sm text-slate-600">
        Planning a route needs an Admin. <Link to="/planner" className="text-brand underline">Back to the plans</Link>
      </div>
    );
  }
  return <Wizard />;
}

function Wizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState<Map<string, PoolStore>>(new Map());
  const [installers, setInstallers] = useState<InstallerDraft[]>([]);
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const previewPlan = usePreviewPlan();
  const create = useCreatePlan();

  const stores = useMemo(() => [...selected.values()], [selected]);
  const problems = installerProblems(installers);
  const startDate = firstStartDate(installers); // the plan's day 1: the earliest installer's start
  const body = (): RoutePlanCreate => ({
    name: name.trim() || defaultName(stores, startDate),
    start_date: startDate,
    // Every installer carries their own limits; the plan's are what a later-added installer starts from.
    stops_per_day: installers[0]?.perDay ?? 10,
    max_day_hours: parseMaxHours(installers[0]?.maxHours ?? "") ?? 0,
    installers: installers.map(installerBody),
    stores: stores.map((store) => ({ project_id: store.project_id, stop_uid: store.uid })),
  });
  const canNext = [stores.length > 0, problems.length === 0, true][step];

  const goto = async (next: number) => {
    if (next === 2) {
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
            Each installer has their own starting location (home or hotel), start date, stops per day and longest driving day. The start can change every day with "Plan
            next day".
          </p>
          <InstallerRows rows={installers} onChange={setInstallers} />
          <div className="max-w-md space-y-1.5 border-t pt-3">
            <Label htmlFor="plan-name">Plan name</Label>
            <Input id="plan-name" placeholder={defaultName(stores, startDate)} value={name} onChange={(e) => setName(e.target.value)} />
            <p className="text-xs text-slate-500">Left blank, the plan is named after its states and first date.</p>
          </div>
        </Card>
      )}

      {step === 2 && preview && <PreviewStep preview={preview} installers={installers} />}

      <div className="flex items-center justify-between gap-3 border-t pt-4">
        <Button variant="outline" onClick={() => (step === 0 ? navigate("/planner") : setStep(step - 1))}>
          <ArrowLeft /> {step === 0 ? "Cancel" : "Back"}
        </Button>
        <span className="font-mono text-xs text-slate-500">
          {stores.length} stores · {installers.length} {installers.length === 1 ? "installer" : "installers"}
        </span>
        {step < 2 ? (
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

/** The days the plan would get. Each installer has their colour, their days (click one to see only that day and
 *  its route on the map; click it again for every day) and the stores of each day in visiting order. */
function PreviewStep({ preview, installers }: { preview: PlanPreview; installers: InstallerDraft[] }) {
  const [picked, setPicked] = useState<{ installer: string; day: number } | null>(null);
  const names = installers.map((installer) => installer.name.trim());
  const colors = Object.fromEntries(names.map((name) => [name, installerColor(names, name)]));
  const rows = installers.map((installer) => {
    const name = installer.name.trim();
    const mine = preview.stops.filter((stop) => stop.installer === name);
    const numbers = [...new Set(mine.map((stop) => stop.day))].sort((a, b) => a - b);
    const days = numbers.map((day, index) => {
      const stops = mine.filter((stop) => stop.day === day).sort((a, b) => a.seq - b.seq);
      // Day 1 sets off from the installer's start; a later day from where the day before ended.
      const before = index > 0 ? mine.filter((stop) => stop.day === numbers[index - 1]).sort((a, b) => a.seq - b.seq).at(-1) : null;
      const from = index === 0 ? installer.start : before && before.lat !== null && before.lng !== null ? { lat: before.lat, lng: before.lng } : null;
      return { day, stops, from, miles: dayMiles(stops, from), minutes: dayDriveMinutes(stops) };
    });
    return { name, color: colors[name]!, start: installer.start, startDate: installer.startDate, perDay: installer.perDay, hours: parseMaxHours(installer.maxHours) ?? 0, days, total: mine.length };
  });
  const isPicked = (name: string, day: number) => picked?.installer === name && picked.day === day;
  const shownStops = picked ? preview.stops.filter((stop) => stop.installer === picked.installer && stop.day === picked.day) : preview.stops;
  const states = [...new Set(preview.stops.map((stop) => stop.state.toUpperCase()).filter(Boolean))];
  const pins: Pin[] = shownStops.flatMap((stop) =>
    stop.lat !== null && stop.lng !== null
      ? [{ uid: planStopKey(stop), lat: stop.lat, lng: stop.lng, status: "Upcoming", store_name: stop.store_name, installer: stop.installer, day: stop.day, route_plan_id: "", visit_state: "none", screen_statuses: [] }]
      : [],
  );
  const routes = rows.flatMap((row) =>
    row.days.filter((day) => !picked || isPicked(row.name, day.day)).map((day) => dayLine(`${row.name}|${day.day}`, row.color, day.stops, day.from, isPicked(row.name, day.day))),
  );
  // A single day shows each stop's place in the order.
  const labels = picked ? Object.fromEntries(shownStops.map((stop) => [planStopKey(stop), String(stop.seq + 1)])) : undefined;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,45%)]">
      <Card className="max-h-[640px] gap-4 overflow-y-auto p-5">
        <p className="text-sm text-slate-600">
          {preview.stops.length} stores in {states.map((s) => US_STATE_NAMES[s] ?? s).join(", ") || "—"}. Each installer's first day is their start date, from their start; later days are a
          forecast that is recalculated every time you plan the next day. Click a day to see only its route on the map.
        </p>
        {skippedMessage(preview.skipped) && <p className="text-xs text-amber-700">{skippedMessage(preview.skipped)}</p>}
        {rows.map((row) => (
          <section key={row.name} aria-label={`${row.name} preview`} className="space-y-2 border-t pt-3">
            <h3 className="flex flex-wrap items-baseline gap-x-3 font-display text-xl tracking-[2px]" style={{ color: row.color }}>
              <span className="flex items-center gap-2">
                <span className="size-3 rounded-full" style={{ background: row.color }} aria-hidden /> {row.name}
              </span>
              <span className="font-mono text-xs tracking-normal text-slate-500">
                {row.total} stops · {row.days.length} {row.days.length === 1 ? "day" : "days"} · {row.perDay}/day{row.hours ? ` · max ${row.hours} h driving` : ""}
              </span>
            </h3>
            {row.start && (
              <p className="truncate text-xs text-slate-500">
                Starts {row.startDate} from {row.start.address}
              </p>
            )}
            {row.days.length === 0 ? (
              <p className="text-xs text-slate-500">No stores near this installer's start.</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label={`${row.name}'s days`}>
                  {row.days.map((day) => (
                    <button
                      key={day.day}
                      type="button"
                      aria-pressed={isPicked(row.name, day.day)}
                      onClick={() => setPicked(isPicked(row.name, day.day) ? null : { installer: row.name, day: day.day })}
                      className={cn("rounded-md border px-2 py-1 font-mono text-[11px]", isPicked(row.name, day.day) ? "text-white" : "bg-slate-50 text-slate-700 hover:bg-slate-100")}
                      style={isPicked(row.name, day.day) ? { background: row.color, borderColor: row.color } : undefined}
                    >
                      Day {day.day}: {day.stops.length} stops · {day.miles} mi{day.minutes !== null ? ` · ${formatDuration(day.minutes)}` : ""}
                    </button>
                  ))}
                </div>
                {row.days
                  .filter((day) => picked?.installer !== row.name || day.day === picked.day)
                  .map((day) => (
                    <div key={day.day} aria-label={`${row.name}, day ${day.day} stores`} role="group">
                      <h4 className="font-mono text-[11px] uppercase tracking-wider text-slate-500">Day {day.day}</h4>
                      <ol className="mt-0.5 space-y-0.5 text-sm">
                        {day.stops.map((stop, index) => (
                          <li key={planStopKey(stop)} className="flex gap-2">
                            <span className="w-5 shrink-0 text-right font-mono text-xs text-slate-400">{index + 1}.</span>
                            <span className="min-w-0 flex-1 truncate">
                              <span className="font-medium text-slate-900">{stop.store_name}</span>{" "}
                              <span className="text-xs text-slate-500">{fullAddress(stop)}</span>
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ))}
              </>
            )}
          </section>
        ))}
      </Card>
      <div className="space-y-1.5">
        <p className="font-mono text-xs text-slate-600" aria-live="polite">
          {picked ? (
            <>
              Showing {picked.installer}, day {picked.day}.{" "}
              <button type="button" className="text-brand underline" onClick={() => setPicked(null)}>
                Show every day
              </button>
            </>
          ) : (
            "Showing every installer and day."
          )}
        </p>
        <MapView className="h-[600px]" pins={pins} installerColors={colors} labels={labels} routes={routes} />
      </div>
    </div>
  );
}
