import { Link } from "react-router";
import { money, projectHardwareCost, type HardwareCosts } from "@/features/stores/details";
import type { HardwareCounts } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const BAR = "#334155";

/** What the completed (installed) hardware of the filtered stores cost: one bar per item (sticks, then Dolphin TVs by
 *  size), each its count × the project's price. Upcoming and in-progress screens are not counted. */
export function HardwareCostChart({
  counts,
  costs,
  projectId,
  className,
}: {
  counts: HardwareCounts | undefined;
  costs: HardwareCosts;
  projectId: string;
  className?: string;
}) {
  const cost = counts ? projectHardwareCost(counts, costs) : null;
  const max = cost ? Math.max(1, ...cost.lines.map((line) => line.count * (line.price ?? 0))) : 1;
  return (
    <section aria-label="Hardware cost" className={cn("flex shrink-0 flex-col gap-2 rounded-xl border bg-white p-3", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-mono text-xs uppercase tracking-wider text-slate-500">Hardware cost</h3>
        <span className="font-mono text-lg font-semibold tabular-nums text-slate-800" aria-label="Hardware cost total">
          {!cost ? "…" : cost.total === null ? "—" : money(cost.total)}
        </span>
      </div>
      <p className="text-xs text-slate-500">
        Completed screens only (online and offline){counts ? ` · ${counts.installed_stores.toLocaleString()} stores` : ""}; follows the filters.
      </p>
      {cost && cost.lines.length === 0 && <p className="py-2 text-center text-sm text-slate-400">No completed screens under these filters.</p>}
      {cost && cost.lines.length > 0 && (
        <ul className="space-y-1.5" aria-label="Hardware cost by item">
          {cost.lines.map((line) => {
            const amount = line.price === null ? null : line.count * line.price;
            return (
              <li key={line.label} className="space-y-0.5 text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-slate-600">
                    {line.count.toLocaleString()} × {line.label}
                    {line.price !== null && <span className="text-slate-400"> @ {money(line.price)}</span>}
                  </span>
                  <span className="font-mono tabular-nums text-slate-800">{amount === null ? <span className="text-amber-700">no price</span> : money(amount)}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-100" aria-hidden>
                  <div className="h-full rounded-full" style={{ width: `${amount === null ? 0 : Math.max(2, (amount / max) * 100)}%`, background: BAR }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {cost && cost.missing.length > 0 && (
        <p className="text-xs text-amber-700">
          No price for {cost.missing.join(", ")}:{" "}
          <Link to={`/projects/${encodeURIComponent(projectId)}/settings`} className="underline underline-offset-2 hover:text-amber-900">
            set it in Settings
          </Link>
          .
        </p>
      )}
    </section>
  );
}
