import type { ReactNode } from "react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { StateCount } from "@/lib/api/types";
import { cn } from "@/lib/utils";

interface Props {
  data: StateCount[];
  /** The State filter; a bar is highlighted when it is the only state selected. */
  selected: string[];
  /** Click a bar or its chip to filter to that state (the full-page view). Without it the chart is read only. */
  onToggle?: (state: string) => void;
  /** Show only the biggest states (the Stores tab shows the top 10). */
  limit?: number;
  /** What the bars count: stores or screens, of every status the filters keep. */
  unit?: "locations" | "screens";
  /** Shown at the right of the title (the Stores tab's "open in a new tab"). */
  action?: ReactNode;
  /** The full-page chart: wider labels, taller rows. */
  large?: boolean;
  className?: string;
}

const ACTIVE = "#0F5B7C";
const IDLE = "#94a3b8";

/** "Top states" by stores or screens of every status under the active filters (STORE-MODEL §5): click a bar (or its button) to filter to that state,
 *  click it again to clear State. Every other filter stays. Default export so the Stores tab loads it lazily. */
export default function TopStatesChart({ data: all, selected, onToggle, limit, unit = "locations", action, large = false, className }: Props) {
  const data = limit ? [...all].sort((a, b) => b.count - a.count).slice(0, limit) : all;
  const only = selected.length === 1 ? selected[0] : null;
  // Every status counts; the status chips (and the other filters) above decide which.
  const base = unit === "screens" ? "Top states by screens" : "Top states by stores";
  const title = limit ? base.replace("Top states", `Top ${limit} states`) : base;
  const what = unit === "screens" ? "Screens" : "Stores";
  return (
    <section className={cn("flex shrink-0 flex-col gap-2 rounded-xl border bg-white p-3", className)} aria-label={title}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-mono text-xs uppercase tracking-wider text-slate-500">{title}</h3>
        {action}
      </div>
      {data.length === 0 ? (
        <p className="py-4 text-center text-sm text-slate-400">No stores under these filters.</p>
      ) : (
        <>
          {/* One row per state, so every state gets a bar and a label however many there are. */}
          <div style={{ height: Math.max(120, data.length * (large ? 30 : 22) + 8) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} layout="vertical" margin={{ left: 4, right: 12, top: 4, bottom: 4 }}>
                <XAxis type="number" allowDecimals={false} hide />
                <YAxis type="category" dataKey="state" width={large ? 44 : 34} interval={0} tick={{ fontSize: large ? 13 : 11 }} />
                <Tooltip cursor={{ fill: "#f1f5f9" }} formatter={(value) => [value, what]} />
                <Bar
                  dataKey="count"
                  radius={[0, 4, 4, 0]}
                  onClick={onToggle ? (entry: { payload?: StateCount }) => entry.payload && onToggle(entry.payload.state) : undefined}
                  cursor={onToggle ? "pointer" : "default"}
                >
                  {data.map((row) => (
                    <Cell key={row.state} fill={only === null || only === row.state ? ACTIVE : IDLE} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          {!onToggle && (
            // Read only: the bars' states and counts for screen readers.
            <ul className="sr-only" aria-label="States">
              {data.map((row) => (
                <li key={row.state}>
                  {row.state} {row.count}
                </li>
              ))}
            </ul>
          )}
          {onToggle && (
          <ul className="flex flex-wrap gap-1" aria-label="States">
            {data.map((row) => (
              <li key={row.state}>
                <button
                  type="button"
                  aria-pressed={only === row.state}
                  onClick={() => onToggle(row.state)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 font-mono text-[10px]",
                    only === row.state ? "border-brand bg-brand text-white" : "text-slate-600 hover:bg-slate-50",
                  )}
                >
                  {row.state} {row.count}
                </button>
              </li>
            ))}
          </ul>
          )}
        </>
      )}
    </section>
  );
}
