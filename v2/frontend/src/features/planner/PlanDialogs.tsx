import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePlanMutations } from "@/features/planner/api";
import { InstallerRows, installerProblems, type InstallerDraft } from "@/features/planner/InstallerRows";
import { isVisited, nextWorkingDay } from "@/features/planner/planModel";
import { StartLocationField } from "@/features/planner/StartLocationField";
import { StorePicker } from "@/features/planner/StorePicker";
import { skippedMessage } from "@/features/planner/PlanWizard";
import type { PoolStore, Replan, RoutePlanBundle, StartLocation } from "@/lib/api/types";

interface DialogProps {
  bundle: RoutePlanBundle;
  open: boolean;
  onClose: () => void;
}

const failure = (error: unknown, fallback: string) => toast.error(error instanceof Error ? error.message : fallback);

/** Close today and plan the next day: a new date, and per installer where they start (default: last visited stop). */
export function NextDayDialog({ bundle, open, onClose }: DialogProps) {
  const { plan } = bundle;
  const current = plan.days.at(-1)!;
  const mutations = usePlanMutations(plan.id);
  const [date, setDate] = useState(nextWorkingDay(current.date));
  const [perDay, setPerDay] = useState(plan.stops_per_day);
  const [starts, setStarts] = useState<Record<string, StartLocation | null>>({});

  useEffect(() => {
    if (!open) return;
    setDate(nextWorkingDay(current.date));
    setPerDay(plan.stops_per_day);
    setStarts(Object.fromEntries(plan.installers.map((i) => [i.name, bundle.next_starts[i.name] ?? i.start])));
  }, [open, bundle, current.date, plan.installers, plan.stops_per_day]);

  const today = bundle.stops.filter((stop) => stop.day === current.number);
  const missed = today.filter((stop) => !isVisited(stop)).length;
  const openCount = bundle.stops.filter((stop) => !isVisited(stop)).length;
  const ready = date > current.date && plan.installers.every((i) => starts[i.name]) && perDay >= 1 && perDay <= 50;

  const submit = async () => {
    try {
      await mutations.nextDay.mutateAsync({
        date,
        stops_per_day: perDay,
        starts: Object.fromEntries(Object.entries(starts).filter((entry): entry is [string, StartLocation] => entry[1] !== null)),
        version: plan.version,
      });
      toast.success(`Day ${current.number + 1} planned for ${date}`);
      onClose();
    } catch (error) {
      failure(error, "Could not plan the next day");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Plan day {current.number + 1}</DialogTitle>
          <DialogDescription>
            Day {current.number} ({current.date}) closes. {missed} of its {today.length} stops were not visited and go back into the pool;
            all {openCount} open stops are recalculated from the starts below.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="next-date">Date</Label>
            <Input id="next-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            {date <= current.date && <p className="text-xs text-rose-700">Pick a date after {current.date}.</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="next-per-day">Stops per day</Label>
            <Input id="next-per-day" type="number" min={1} max={50} value={perDay} onChange={(e) => setPerDay(Number(e.target.value))} />
          </div>
        </div>
        <div className="space-y-3">
          <p className="text-xs text-slate-500">Each installer starts where they finished today unless you type a new location.</p>
          {plan.installers.map((installer) => (
            <div key={installer.name} className="space-y-1">
              <Label>{installer.name}</Label>
              <StartLocationField
                label={`Next start for ${installer.name}`}
                value={starts[installer.name] ?? null}
                onChange={(value) => setStarts((current) => ({ ...current, [installer.name]: value }))}
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!ready || mutations.nextDay.isPending}>
            {mutations.nextDay.isPending && <Loader2 className="animate-spin" />} Recalculate and plan day {current.number + 1}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const REPLAN_LABELS: Record<Replan, string> = {
  forecast: "Recalculate the coming days (today stays as it is)",
  today: "Recalculate today too",
  none: "Do not recalculate",
};

function ReplanSelect({ value, onChange, allowNone = true }: { value: Replan; onChange: (value: Replan) => void; allowNone?: boolean }) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as Replan)}>
      <SelectTrigger aria-label="Recalculate" className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(REPLAN_LABELS) as Replan[])
          .filter((key) => allowNone || key !== "none")
          .map((key) => (
            <SelectItem key={key} value={key}>
              {REPLAN_LABELS[key]}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}

/** Rename, change the cap, add or remove installers and their starts. */
export function EditPlanDialog({ bundle, open, onClose }: DialogProps) {
  const { plan } = bundle;
  const mutations = usePlanMutations(plan.id);
  const [name, setName] = useState(plan.name);
  const [perDay, setPerDay] = useState(plan.stops_per_day);
  const [rows, setRows] = useState<InstallerDraft[]>([]);
  const [replan, setReplan] = useState<Replan>("forecast");

  useEffect(() => {
    if (!open) return;
    setName(plan.name);
    setPerDay(plan.stops_per_day);
    setRows(plan.installers.map((i) => ({ name: i.name, start: i.start })));
    setReplan("forecast");
  }, [open, plan]);

  const problems = installerProblems(rows);
  const submit = async () => {
    try {
      await mutations.update.mutateAsync({
        name: name.trim(),
        stops_per_day: perDay,
        installers: rows.map((row) => ({ name: row.name.trim(), start: row.start! })),
        replan,
        version: plan.version,
      });
      toast.success("Plan updated");
      onClose();
    } catch (error) {
      failure(error, "Could not update the plan");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Edit plan</DialogTitle>
          <DialogDescription>Removing an installer who still has stops today needs "Recalculate today too".</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="edit-name">Name</Label>
            <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-per-day">Stops per day</Label>
            <Input id="edit-per-day" type="number" min={1} max={50} value={perDay} onChange={(e) => setPerDay(Number(e.target.value))} />
          </div>
        </div>
        <div className="max-h-[45vh] overflow-y-auto">
          <InstallerRows rows={rows} onChange={setRows} />
        </div>
        <ReplanSelect value={replan} onChange={setReplan} />
        {problems.length > 0 && <p className="text-xs text-amber-700">{problems[0]}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={problems.length > 0 || !name.trim() || mutations.update.isPending}>
            {mutations.update.isPending && <Loader2 className="animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Pick more stores (any project) and fold them into the plan. */
export function AddStoresDialog({ bundle, open, onClose }: DialogProps) {
  const mutations = usePlanMutations(bundle.plan.id);
  const [selected, setSelected] = useState<Map<string, PoolStore>>(new Map());
  const [replan, setReplan] = useState<Replan>("forecast");

  useEffect(() => {
    if (open) setSelected(new Map());
  }, [open]);

  const submit = async () => {
    try {
      const result = await mutations.addStores.mutateAsync({
        stores: [...selected.values()].map((store) => ({ project_id: store.project_id, stop_uid: store.uid })),
        replan,
        version: bundle.plan.version,
      });
      const note = skippedMessage(result.skipped);
      toast.success(`Added ${selected.size - result.skipped.length} stores`, note ? { description: note } : undefined);
      onClose();
    } catch (error) {
      failure(error, "Could not add the stores");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-[min(1400px,95vw)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add stores to {bundle.plan.name}</DialogTitle>
          <DialogDescription>New stores go to the coming days unless you recalculate today too.</DialogDescription>
        </DialogHeader>
        <StorePicker selected={selected} onChange={setSelected} planId={bundle.plan.id} />
        <DialogFooter className="items-center gap-2 sm:justify-between">
          <div className="w-80">
            <ReplanSelect value={replan} onChange={setReplan} allowNone={false} />
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={selected.size === 0 || mutations.addStores.isPending}>
              {mutations.addStores.isPending && <Loader2 className="animate-spin" />} Add {selected.size} stores
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
