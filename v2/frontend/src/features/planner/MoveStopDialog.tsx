import { useEffect, useState } from "react";
import { CalendarX, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePlanMutations, useRoutePlans } from "@/features/planner/api";
import { fullAddress } from "@/features/planner/planModel";
import { useCan } from "@/lib/auth/me";
import type { PlanStop, RoutePlanBundle } from "@/lib/api/types";

interface Props {
  bundle: RoutePlanBundle;
  stop: PlanStop | null;
  onClose: () => void;
  /** Take the store out of the plan for good instead (asks first). Only offered to someone who manages plans. */
  onRemove: (stop: PlanStop) => void;
  /** Take the store off its day and keep it with the plan, as removed, for a manager to decide on. */
  onSetAside: (stop: PlanStop) => void;
}

/** Move one store: to another day or another installer, or (for someone who manages plans) another active plan. It
 *  lands where it adds the least driving on that day and stays there (pinned) when the plan is recalculated.
 *  Taking it off its day is here too. A store that was set aside is put back on a day with the same form. */
export function MoveStopDialog({ bundle, stop, onClose, onRemove, onSetAside }: Props) {
  const { plan } = bundle;
  const mutations = usePlanMutations(plan.id);
  const canManage = useCan("routes.manage");
  const restoring = Boolean(stop?.removed);
  const active = useRoutePlans("active");
  const [planId, setPlanId] = useState(plan.id);
  const [installer, setInstaller] = useState("");
  const [day, setDay] = useState("");
  const plans = [plan, ...(active.data ?? []).filter((other) => other.id !== plan.id)];
  const target = plans.find((other) => other.id === planId) ?? plan;
  const today = target.days.at(-1)?.number ?? 1;

  useEffect(() => {
    if (!stop) return;
    setPlanId(plan.id);
    setInstaller(stop.installer || (plan.installers[0]?.name ?? ""));
    setDay(String(Math.max(stop.day, plan.days.at(-1)?.number ?? 1)));
  }, [stop, plan.id, plan.days]);

  const choosePlan = (id: string) => {
    const next = plans.find((other) => other.id === id) ?? plan;
    setPlanId(id);
    setInstaller(next.installers.some((person) => person.name === stop?.installer) ? (stop?.installer ?? "") : (next.installers[0]?.name ?? ""));
    setDay(String(next.days.at(-1)?.number ?? 1));
  };
  const number = Number(day);
  const same = stop !== null && planId === plan.id && installer === stop.installer && number === stop.day;
  const problem = !installer ? "Choose the installer." : !(Number.isInteger(number) && number >= today) ? `Day ${today} is today in this plan: choose it or a later day.` : "";
  const hasVisit = (stop?.visited_screens.length ?? 0) > 0;

  const submit = async () => {
    if (!stop) return;
    try {
      await (restoring ? mutations.restore : mutations.move).mutateAsync({
        projectId: stop.project_id,
        uid: stop.stop_uid,
        body: { installer, day: number, to_plan_id: restoring || planId === plan.id ? null : planId, version: plan.version },
      });
      toast.success(planId === plan.id ? `${stop.store_name} is on ${installer}'s day ${number}` : `${stop.store_name} moved to ${target.name}`);
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not move the store");
    }
  };

  return (
    <Dialog open={stop !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{restoring ? `Put ${stop?.store_name} back on a day` : `Move ${stop?.store_name}`}</DialogTitle>
          <DialogDescription>
            {stop && fullAddress(stop)}. {restoring ? `Taken off its day${stop?.removed_by ? ` by ${stop.removed_by}` : ""}.` : `Now on ${stop?.installer}'s day ${stop?.day}.`} It goes where it adds the least driving on the day you choose, and stays
            on that day when the plan is recalculated.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {/* Another plan takes the store out of this one: only for someone who manages plans. */}
          <div hidden={!canManage || restoring} className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="move-plan">Plan</Label>
            <Select value={planId} onValueChange={choosePlan} disabled={hasVisit}>
              <SelectTrigger id="move-plan" aria-label="Plan" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {plans.map((other) => (
                  <SelectItem key={other.id} value={other.id}>
                    {other.id === plan.id ? `${other.name} (this plan)` : other.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {hasVisit && <p className="text-xs text-slate-500">A visit is logged for it in this plan, so it stays in this plan.</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="move-installer">Installer</Label>
            <Select value={installer} onValueChange={setInstaller}>
              <SelectTrigger id="move-installer" aria-label="Move to installer" className="w-full">
                <SelectValue placeholder="Select an installer" />
              </SelectTrigger>
              <SelectContent>
                {target.installers.map((person) => (
                  <SelectItem key={person.name} value={person.name}>
                    {person.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="move-day">Day</Label>
            <Input id="move-day" type="number" min={today} value={day} onChange={(event) => setDay(event.target.value)} />
            <p className="text-xs text-slate-500">Day {today} is today in this plan.</p>
          </div>
        </div>
        {problem && <p className="text-xs text-amber-700">{problem}</p>}
        <DialogFooter className="items-center gap-2 sm:justify-between">
          <div className="flex flex-wrap gap-2">
            {!restoring && (
              <Button
                type="button"
                variant="outline"
                className="text-amber-800"
                disabled={hasVisit}
                title={hasVisit ? "A store with a visit logged stays where it was visited" : "Off its day, kept with the plan as removed: an Admin puts it back or takes it out"}
                onClick={() => {
                  if (stop) onSetAside(stop);
                  onClose();
                }}
              >
                <CalendarX /> Remove from this day
              </Button>
            )}
            {canManage && (
              <Button
                type="button"
                variant="outline"
                className="text-rose-700"
                disabled={hasVisit}
                title={hasVisit ? "A store with a visit logged stays in the plan's history" : "Out of the plan for good: it can join another plan"}
                onClick={() => {
                  if (stop) onRemove(stop);
                  onClose();
                }}
              >
                <Trash2 /> Remove from plan
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void submit()} disabled={Boolean(problem) || (same && !restoring) || mutations.move.isPending || mutations.restore.isPending}>
              {(mutations.move.isPending || mutations.restore.isPending) && <Loader2 className="animate-spin" />} {restoring ? "Put back" : "Move"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
