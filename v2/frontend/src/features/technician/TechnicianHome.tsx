import { useEffect, useState } from "react";
import { Check, Loader2, Map as MapIcon, MapPin } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { dayDriveMinutes, dayMapsLinks, formatDuration, fullAddress, groupPlan, stopState, type PlanDayView } from "@/features/planner/planModel";
import { useMyRoute, useSaveMyProfile } from "@/features/technician/api";
import type { NameEntry, PlanStop, RoutePlanBundle } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const STATE_LABEL = { done: "Done", incomplete: "Incomplete", route: "To do" } as const;
const STATE_TONE = {
  done: "border-emerald-300 bg-emerald-50 text-emerald-800",
  incomplete: "border-amber-300 bg-amber-50 text-amber-800",
  route: "border-sky-300 bg-sky-50 text-sky-800",
} as const;

interface MyDay extends PlanDayView {
  plan: string;
  planId: string;
}

/** Every day of theirs, across the plans they are on: finished days, today's, and the ones to come. */
export function myDays(plans: RoutePlanBundle[]): MyDay[] {
  return plans.flatMap((bundle) => (groupPlan(bundle)[0]?.days ?? []).map((day) => ({ ...day, plan: bundle.plan.name, planId: bundle.plan.id })));
}

/** What a technician sees: today's route, the days to come, how much they have serviced, and their own details
 *  (additional phone and shipping address are theirs to change). Nothing of anyone else's. */
export function TechnicianHome() {
  const route = useMyRoute();
  if (route.isPending) return <p className="p-8 text-center font-mono text-sm text-slate-500">Loading your route…</p>;
  if (route.isError) return <p className="p-8 text-center text-sm text-rose-700">Could not load your route: {route.error.message}</p>;
  const { installer, plans, serviced_before: before, fixed } = route.data;
  if (!installer) {
    return (
      <div className="mx-auto max-w-md rounded-xl border bg-white p-8 text-center text-sm text-slate-600 shadow-sm">
        <h1 className="mb-2 text-lg font-semibold text-slate-900">Your sign-in is not linked to an installer yet</h1>
        Ask your Dolphin manager to add your email to your entry on the Installers page.
      </div>
    );
  }
  const days = myDays(plans);
  const today = days.filter((day) => day.kind === "current");
  const upcoming = days.filter((day) => day.kind === "forecast");
  const past = days.filter((day) => day.kind === "past");
  const stops = plans.flatMap((bundle) => bundle.stops);
  const count = (list: PlanStop[], state: keyof typeof STATE_LABEL) => list.filter((stop) => stopState(stop) === state).length;
  const todayStops = today.flatMap((day) => day.stops);
  const tiles: [string, number, string][] = [
    ["Serviced", before + count(stops, "done"), before ? `${count(stops, "done")} on current routes · ${before} before` : "on your current routes"],
    ["Today", todayStops.length, `${todayStops.length - count(todayStops, "done")} still to do`],
    ["Upcoming", upcoming.reduce((sum, day) => sum + day.stops.length, 0), `over ${upcoming.length} ${upcoming.length === 1 ? "day" : "days"}`],
    ["Incomplete", count(stops, "incomplete"), "to go back to"],
  ];
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <h1 className="font-display text-3xl tracking-[2px]">{installer.value}</h1>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Your numbers">
        {tiles.map(([label, value, note]) => (
          <div key={label} className="rounded-xl border bg-white p-3 shadow-sm">
            <dt className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{label}</dt>
            <dd className="text-2xl font-semibold tabular-nums text-slate-900">{value}</dd>
            <dd className="text-xs text-slate-500">{note}</dd>
          </div>
        ))}
      </dl>

      {/* Their record across every project: stores they are the technician of that are Completed now. */}
      <section aria-label="Stores fixed so far" className="rounded-xl border bg-white p-4 shadow-sm">
        <h2 className="font-mono text-xs uppercase tracking-[2px] text-slate-500">Stores fixed so far</h2>
        <dl className="mt-2 flex flex-wrap gap-x-8 gap-y-2">
          {(
            [
              ["Total", fixed.new_installation + fixed.offline + fixed.mixed],
              ["New installations", fixed.new_installation],
              ["Offline fixed", fixed.offline],
              ...(fixed.mixed ? ([["In mixed projects", fixed.mixed]] as [string, number][]) : []),
            ] as [string, number][]
          ).map(([label, value]) => (
            <div key={label}>
              <dd className="text-2xl font-semibold tabular-nums text-slate-900">{value}</dd>
              <dt className="text-xs text-slate-500">{label}</dt>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-slate-500">Completed stores with you as the technician, in every project.</p>
      </section>

      <section aria-label="Today" className="space-y-2">
        <h2 className="font-mono text-xs uppercase tracking-[2px] text-slate-500">Today</h2>
        {today.length === 0 ? (
          <p className="rounded-xl border bg-white p-5 text-sm text-slate-500">{plans.length ? "Nothing for you today." : "You are not on a route right now."}</p>
        ) : (
          today.map((day) => <DayCard key={`${day.planId}|${day.number}`} day={day} open />)
        )}
      </section>

      {upcoming.length > 0 && (
        <section aria-label="Upcoming days" className="space-y-2">
          <h2 className="font-mono text-xs uppercase tracking-[2px] text-slate-500">Coming up · may still change</h2>
          {upcoming.map((day) => (
            <DayCard key={`${day.planId}|${day.number}`} day={day} />
          ))}
        </section>
      )}

      {past.length > 0 && (
        <section aria-label="Earlier days" className="space-y-2">
          <h2 className="font-mono text-xs uppercase tracking-[2px] text-slate-500">Earlier days</h2>
          {past.map((day) => (
            <DayCard key={`${day.planId}|${day.number}`} day={day} />
          ))}
        </section>
      )}

      <Profile installer={installer} />
    </div>
  );
}

function DayCard({ day, open = false }: { day: MyDay; open?: boolean }) {
  const todo = day.stops.filter((stop) => stopState(stop) !== "done");
  const drive = dayDriveMinutes(day.stops);
  // A forecast day has no start yet (it follows where the day before ends), so its link runs store to store.
  const links = dayMapsLinks(day.kind === "forecast" ? null : day.start, todo);
  return (
    <details open={open} className="group rounded-xl border bg-white shadow-sm" aria-label={`Day ${day.number} of ${day.plan}`}>
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
        <span className="font-display text-xl tracking-[2px] text-slate-900">Day {day.number}</span>
        {day.date && <span className="font-mono text-xs text-slate-600">{day.date}</span>}
        <span className="font-mono text-[11px] text-slate-500">{day.plan}</span>
        <span className="ml-auto font-mono text-[11px] text-slate-500">
          {day.stops.length} {day.stops.length === 1 ? "store" : "stores"} · {day.stops.length - todo.length} done
          {drive !== null ? ` · ≈ ${formatDuration(drive)} driving` : ""}
        </span>
      </summary>
      <ol className="divide-y border-t">
        {day.stops.map((stop, index) => {
          const state = stopState(stop);
          return (
            <li key={`${stop.project_id}#${stop.stop_uid}`} className={cn("flex gap-3 px-4 py-2.5", state === "done" && "bg-emerald-50/40")}>
              <span className="w-5 shrink-0 pt-0.5 font-mono text-xs text-slate-400">{index + 1}.</span>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-slate-900">{stop.store_name}</div>
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fullAddress(stop))}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-start gap-1 text-sm text-brand underline"
                >
                  <MapPin size={14} className="mt-0.5 shrink-0" /> {fullAddress(stop)}
                </a>
                <div className="font-mono text-[11px] text-slate-500">
                  {stop.external_id ? `${stop.external_id} · ` : ""}
                  {stop.screen_ids.length} {stop.screen_ids.length === 1 ? "screen" : "screens"}
                  {stop.drive_minutes !== null && stop.drive_minutes !== undefined ? ` · ${formatDuration(stop.drive_minutes)} drive from the stop before` : ""}
                </div>
              </div>
              <span className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] font-medium", STATE_TONE[state])}>
                {state === "done" && <Check size={12} />} {STATE_LABEL[state]}
              </span>
            </li>
          );
        })}
      </ol>
      {day.kind !== "past" && links.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t p-3">
          {links.map((link) => (
            <Button key={link.url} asChild size="lg">
              <a href={link.url} target="_blank" rel="noopener noreferrer">
                <MapIcon /> {link.label}
              </a>
            </Button>
          ))}
          {day.start && day.kind === "current" && <span className="self-center text-xs text-slate-500">from {day.start.address}</span>}
        </div>
      )}
    </details>
  );
}

function Profile({ installer }: { installer: NameEntry }) {
  const save = useSaveMyProfile();
  const [phone2, setPhone2] = useState(installer.phone2);
  const [address, setAddress] = useState(installer.shipping_address);
  useEffect(() => {
    setPhone2(installer.phone2);
    setAddress(installer.shipping_address);
  }, [installer.phone2, installer.shipping_address]);
  const changed = phone2.trim() !== installer.phone2 || address.trim() !== installer.shipping_address;
  const fixed: [string, string][] = [
    ["Name", installer.value],
    ["Phone", installer.phone],
    ["Email", installer.email],
  ];
  return (
    <section aria-label="Your details" className="space-y-4 rounded-xl border bg-white p-5 shadow-sm">
      <h2 className="font-mono text-xs uppercase tracking-[2px] text-slate-500">Your details</h2>
      <dl className="grid gap-3 sm:grid-cols-3">
        {fixed.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-slate-500">{label}</dt>
            <dd className="break-words text-sm font-medium text-slate-900">{value || <span className="font-normal text-slate-300">—</span>}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-slate-500">Your name, phone and email are changed by your Dolphin manager. The two below are yours to keep up to date.</p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(
            { phone2: phone2.trim(), shipping_address: address.trim() },
            { onSuccess: () => toast.success("Your details are saved"), onError: (error) => toast.error(error instanceof Error ? error.message : "Could not save") },
          );
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="my-phone2">Additional phone</Label>
          <Input id="my-phone2" type="tel" className="sm:max-w-xs" value={phone2} onChange={(event) => setPhone2(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="my-address">Shipping address</Label>
          <Textarea id="my-address" rows={2} placeholder="Where hardware should be shipped to you" value={address} onChange={(event) => setAddress(event.target.value)} />
        </div>
        <Button type="submit" disabled={!changed || save.isPending}>
          {save.isPending && <Loader2 className="animate-spin" />} Save my details
        </Button>
      </form>
    </section>
  );
}
