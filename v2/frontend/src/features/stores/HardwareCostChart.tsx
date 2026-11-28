import { Link } from "react-router";
import { money, projectHardwareCost, type HardwareCosts } from "@/features/stores/details";
import type { HardwareCounts } from "@/lib/api/types";
import { cn } from "@/lib/utils";

/** Sticks in slate; the screen models in a light → dark indigo scale, in the order listed (sizes ascending). */
const SCREEN_TONES = ["#a5b4fc", "#818cf8", "#6366f1", "#4f46e5", "#3730a3", "#1e1b4b"];

/** What the completed (installed) hardware of the filtered stores cost: one bar split by item (sticks, then Dolphin
 *  screens by model), each segment the item's share of the priced total, with the count × price behind it listed below.
 *  Upcoming screens are not counted. */
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
  // The sum of the priced lines (`cost.total` is null when a price is missing, but the priced lines still compare).
  const priced = cost ? cost.lines.reduce((sum, line) => sum + line.count * (line.price ?? 0), 0) : 0;
  const screenLines = cost ? cost.lines.filter((line) => line.label !== "Sticks").map((line) => line.label) : [];
  const pick = (tones: string[], index: number, fallback: string) => tones[Math.min(index, tones.length - 1)] ?? fallback;
  const tone = (label: string) => (label === "Sticks" ? "var(--color-slate-700)" : pick(SCREEN_TONES, screenLines.indexOf(label), "#94a3b8"));
  const shareOf = (line: { count: number; price: number | null }) =>
    line.price === null || priced <= 0 ? null : ((line.count * line.price) / priced) * 100;
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
        <>
          {/* One bar for the whole cost: the segments add up to 100%. */}
          <div className="flex h-2.5 gap-px overflow-hidden rounded-full bg-slate-100" aria-hidden>
            {cost.lines.map((line) => {
              const share = shareOf(line);
              return share === null ? null : <div key={line.label} style={{ width: `${share}%`, background: tone(line.label) }} title={`${line.label}: ${Math.round(share)}%`} />;
            })}
          </div>
          <ul className="space-y-1" aria-label="Hardware cost by item">
            {cost.lines.map((line) => {
              const amount = line.price === null ? null : line.count * line.price;
              const share = shareOf(line);
              return (
                <li key={line.label} className="flex items-baseline gap-2 text-xs">
                  <span className="size-2 shrink-0 translate-y-px rounded-sm" style={{ background: amount === null ? "var(--color-slate-200)" : tone(line.label) }} aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-slate-600">
                    {line.count.toLocaleString()} × {line.label}
                    {line.price !== null && <span className="text-slate-400"> @ {money(line.price)}</span>}
                  </span>
                  <span className="font-mono tabular-nums text-slate-800">{amount === null ? <span className="text-amber-700">no price</span> : money(amount)}</span>
                  {share !== null && <span className="w-9 text-right font-mono tabular-nums text-slate-500">{Math.round(share)}%</span>}
                </li>
              );
            })}
          </ul>
        </>
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
