import { useCan } from "@/lib/auth/me";
import { useState } from "react";
import { Link } from "react-router";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRoutePlans } from "@/features/planner/api";
import type { PlanStatus } from "@/lib/api/types";

/** The Route Planner's home: active (or closed) plans, and "Plan a route". */
export function PlannerHome() {
  const [status, setStatus] = useState<PlanStatus>("active");
  const plans = useRoutePlans(status);
  const canManage = useCan("routes.manage");
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-mono text-xs uppercase tracking-[2px] text-slate-500">Route planner</h1>
        {canManage && (
          <Button asChild className="font-mono font-semibold uppercase tracking-wider">
            <Link to="/planner/new">
              <Plus /> Plan a route
            </Link>
          </Button>
        )}
      </div>
      <Tabs value={status} onValueChange={(value) => setStatus(value as PlanStatus)}>
        <TabsList>
          <TabsTrigger value="active">Active</TabsTrigger>
          <TabsTrigger value="closed">Closed</TabsTrigger>
        </TabsList>
      </Tabs>
      {plans.isPending ? (
        <Card className="p-8 text-center font-mono text-slate-500">Loading plans…</Card>
      ) : plans.isError ? (
        <Card className="p-8 text-center text-rose-700">Could not load plans: {plans.error.message}</Card>
      ) : plans.data.length === 0 ? (
        <Card className="p-8 text-center text-sm text-slate-500">
          {status === "active" ? (canManage ? "No active plans. Plan a route to send installers out across one or more projects." : "No active plans.") : "No closed plans yet."}
        </Card>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {plans.data.map((plan) => {
            const current = plan.days.at(-1);
            return (
              <li key={plan.id}>
                <Link to={`/planner/${plan.id}`} className="block">
                  <Card className="gap-2 p-4 transition-all hover:border-brand/60 hover:shadow-md">
                    <div className="font-display text-xl tracking-[2px]">{plan.name}</div>
                    <div className="font-mono text-xs text-slate-600">
                      {plan.store_count} stores · {plan.installers.length} {plan.installers.length === 1 ? "installer" : "installers"} · {plan.stops_per_day}/day
                    </div>
                    <div className="font-mono text-[11px] text-slate-500">
                      {status === "active" ? `Day ${current?.number} · ${current?.date}` : `Started ${plan.days[0]?.date} · ${plan.days.length} days`}
                    </div>
                    <div className="truncate text-xs text-slate-500">{plan.installers.map((i) => i.name).join(", ")}</div>
                    {plan.summary && (
                      <div className="flex flex-wrap gap-1.5 pt-1 font-mono text-[11px]" aria-label="How the plan ended">
                        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-800">{plan.summary.done} done</span>
                        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800">{plan.summary.incomplete} incomplete</span>
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-700">{plan.summary.not_visited} not visited</span>
                        {plan.summary.removed > 0 && <span className="rounded bg-rose-50 px-1.5 py-0.5 text-rose-800">{plan.summary.removed} removed</span>}
                      </div>
                    )}
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
