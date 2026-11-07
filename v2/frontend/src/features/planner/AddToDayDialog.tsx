import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { usePlanMutations } from "@/features/planner/api";
import { dayDriveMinutes, dayLimits, formatDuration, fullAddress, isVisited, planStopKey } from "@/features/planner/planModel";
import { StorePicker } from "@/features/planner/StorePicker";
import { routePlansApi } from "@/lib/api/resources";
import type { PlanStop, PoolStore, RoutePlanBundle, StoreRef } from "@/lib/api/types";
import { cn } from "@/lib/utils";

interface Props {
  bundle: RoutePlanBundle;
  installer: string;
  day: number;
  /** The day as forecast (no own limits) or as planned. */
  forecast: boolean;
  open: boolean;
  onClose: () => void;
}

type Source = "plan" | "free";

/** Add one store to an installer's day at a chosen place: from another day of this plan, or a store in no plan.
 *  Every place is listed between its two neighbours with the extra driving it costs; the cheapest is marked. */
export function AddToDayDialog({ bundle, installer, day, forecast, open, onClose }: Props) {
  const mutations = usePlanMutations(bundle.plan.id);
  const [source, setSource] = useState<Source>("plan");
  const [store, setStore] = useState<(StoreRef & { name: string }) | null>(null);
  const [position, setPosition] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setSource("plan");
    setStore(null);
    setPosition(null);
  }, [open]);

  const options = useQuery({
    queryKey: ["insert-options", bundle.plan.id, bundle.plan.version, installer, day, store?.project_id, store?.stop_uid],
    queryFn: () => routePlansApi.insertOptions(bundle.plan.id, { installer, day, store: { project_id: store!.project_id, stop_uid: store!.stop_uid } }),
    enabled: open && store !== null,
  });
  useEffect(() => {
    const best = options.data?.options.find((option) => option.best);
    setPosition(best ? best.position : null);
  }, [options.data]);

  const thisDay = bundle.stops.filter((stop) => stop.installer === installer && stop.day === day);
  const limits = dayLimits(bundle.plan, forecast ? undefined : day);
  const chosen = options.data?.options.find((option) => option.position === position);
  const drive = (dayDriveMinutes(thisDay) ?? 0) + (chosen?.extra_minutes ?? 0);
  const alreadyHere = store && thisDay.some((stop) => stop.project_id === store.project_id && stop.stop_uid === store.stop_uid);
  const warnings = [
    thisDay.length + (alreadyHere ? 0 : 1) > limits.perDay ? `${thisDay.length + 1} stores is over this day's ${limits.perDay}.` : "",
    limits.hours && chosen && drive > limits.hours * 60 ? `About ${formatDuration(drive)} of driving is over this day's ${limits.hours} h.` : "",
  ].filter(Boolean);

  const submit = async () => {
    if (!store || position === null) return;
    try {
      await mutations.insert.mutateAsync({
        installer,
        day,
        position,
        store: { project_id: store.project_id, stop_uid: store.stop_uid },
        version: bundle.plan.version,
      });
      toast.success(`Added ${store.name} to ${installer}, day ${day}`);
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not add the store");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-[min(1200px,95vw)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Add a store to {installer}, day {day}
          </DialogTitle>
          <DialogDescription>
            Pick a store, then where it goes. The day keeps this order until it is recalculated; lock the day to keep it for good.
          </DialogDescription>
        </DialogHeader>

        {!store ? (
          <>
            <div className="flex gap-1 rounded-lg border bg-white p-1" role="tablist" aria-label="Where the store comes from">
              {(
                [
                  ["plan", "From another day of this plan"],
                  ["free", "A store in no plan"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={source === value}
                  onClick={() => setSource(value)}
                  className={cn("flex-1 rounded-md px-3 py-1.5 text-sm", source === value ? "bg-brand text-white" : "text-slate-600 hover:bg-slate-100")}
                >
                  {label}
                </button>
              ))}
            </div>
            {source === "plan" ? (
              <PlanStorePicker bundle={bundle} installer={installer} day={day} onPick={(stop) => setStore({ project_id: stop.project_id, stop_uid: stop.stop_uid, name: stop.store_name })} />
            ) : (
              <SinglePoolPicker planId={bundle.plan.id} onPick={(picked) => setStore({ project_id: picked.project_id, stop_uid: picked.uid, name: picked.store_name })} />
            )}
          </>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 rounded-lg border bg-slate-50 px-3 py-2 text-sm">
              <span>
                Adding <strong>{store.name}</strong>
              </span>
              <Button size="sm" variant="ghost" onClick={() => setStore(null)}>
                Pick another store
              </Button>
            </div>
            {options.isPending ? (
              <p className="flex items-center gap-2 text-sm text-slate-500">
                <Loader2 className="size-4 animate-spin" /> Working out the driving for each place…
              </p>
            ) : options.isError ? (
              <p className="text-sm text-rose-700">{options.error.message}</p>
            ) : (
              <fieldset className="space-y-1.5">
                <legend className="mb-1 text-sm font-medium">Where should it go?</legend>
                {options.data.options.map((option) => (
                  <label
                    key={option.position}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm",
                      position === option.position ? "border-brand bg-brand/5" : "hover:bg-slate-50",
                    )}
                  >
                    <input type="radio" name="position" checked={position === option.position} onChange={() => setPosition(option.position)} />
                    <span className="flex-1">
                      {option.after ? <strong>{option.after}</strong> : <span className="text-slate-500">Day start</span>}
                      <span className="mx-2 text-slate-400">→</span>
                      <span className="rounded bg-brand/10 px-1.5 py-0.5 text-brand">{store.name}</span>
                      <span className="mx-2 text-slate-400">→</span>
                      {option.before ? <strong>{option.before}</strong> : <span className="text-slate-500">End of day</span>}
                    </span>
                    <span className="font-mono text-xs text-slate-600">+{formatDuration(option.extra_minutes)}</span>
                    {option.best && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">Best</span>}
                  </label>
                ))}
              </fieldset>
            )}
            {warnings.map((warning) => (
              <p key={warning} className="flex items-center gap-1.5 text-xs text-amber-700">
                <AlertTriangle className="size-3.5" /> {warning} You can still add it.
              </p>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!store || position === null || mutations.insert.isPending}>
            {mutations.insert.isPending && <Loader2 className="animate-spin" />} Add here
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Open stores on this plan's other days (and other installers), searchable by name, address or day. */
function PlanStorePicker({ bundle, installer, day, onPick }: { bundle: RoutePlanBundle; installer: string; day: number; onPick: (stop: PlanStop) => void }) {
  const [query, setQuery] = useState("");
  const current = bundle.plan.days.at(-1)?.number ?? 1;
  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return bundle.stops
      .filter((stop) => !isVisited(stop) && !(stop.installer === installer && stop.day === day) && stop.day >= current)
      .filter((stop) => !needle || `${stop.store_name} ${fullAddress(stop)} ${stop.installer} day ${stop.day}`.toLowerCase().includes(needle))
      .sort((a, b) => a.day - b.day || a.installer.localeCompare(b.installer) || a.seq - b.seq);
  }, [bundle.stops, query, installer, day, current]);
  return (
    <div className="space-y-2">
      <Input aria-label="Search this plan's stores" placeholder="Search name, address, installer or day…" value={query} onChange={(e) => setQuery(e.target.value)} />
      {candidates.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">No open store on another day matches.</p>
      ) : (
        <ul className="max-h-[50vh] divide-y overflow-y-auto rounded-lg border">
          {candidates.map((stop) => (
            <li key={planStopKey(stop)}>
              <button type="button" className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50" onClick={() => onPick(stop)}>
                <span className="w-28 shrink-0 font-mono text-[11px] text-slate-500">
                  {stop.installer}, day {stop.day}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{stop.store_name}</span>
                  <span className="block truncate text-xs text-slate-500">{fullAddress(stop)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The cross-project store picker, taking the first store picked. */
function SinglePoolPicker({ planId, onPick }: { planId: string; onPick: (store: PoolStore) => void }) {
  const [selected, setSelected] = useState<Map<string, PoolStore>>(new Map());
  return (
    <StorePicker
      selected={selected}
      planId={planId}
      onChange={(next) => {
        const added = [...next.entries()].find(([key]) => !selected.has(key));
        setSelected(new Map());
        if (added) onPick(added[1]);
      }}
    />
  );
}
