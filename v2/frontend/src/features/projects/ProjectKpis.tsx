import { screenTotals } from "@/features/dashboard/aggregate";
import { STOP_STATUSES, type Kpi } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";
import { cn } from "@/lib/utils";

/** Project header KPIs (STORE-MODEL §5): stores by derived status and pending, screens, committed vs actual. */
export function ProjectKpis({ kpi }: { kpi: Kpi }) {
  const screens = screenTotals([kpi]);
  return (
    <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]" role="group" aria-label="Project KPIs">
      <span className="rounded border bg-white px-2 py-0.5">
        {kpi.total} stores · <b>{kpi.pending}</b> pending
      </span>
      {STOP_STATUSES.filter((status) => kpi.by_status[status]).map((status) => (
        <span key={status} className={cn("rounded border px-2 py-0.5", STATUS_META[status].chip)}>
          {STATUS_META[status].label} {kpi.by_status[status]}
        </span>
      ))}
      <span className="rounded border bg-white px-2 py-0.5" aria-label="Screens">
        {screens.total} screens · Dolphin {screens.actualDolphin}/{screens.committedDolphin} committed · TVs {screens.actualTvs}/
        {screens.committedTvs} committed
      </span>
    </div>
  );
}
