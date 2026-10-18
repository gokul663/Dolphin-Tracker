import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { StateCount } from "@/lib/api/types";
import { cn } from "@/lib/utils";

interface Props {
  data: StateCount[];
  /** The State filter; a bar is highlighted when it is the only state selected. */
  selected: string[];
  onToggle: (state: string) => void;
}

const ACTIVE = "#0F5B7C";
const IDLE = "#94a3b8";

/** "Top states by upcoming installs" (STORE-MODEL §5): click a bar (or its button) to filter to that state,
 *  click it again to clear State. Every other filter stays. Default export so the Stores tab loads it lazily. */
export default function TopStatesChart({ data, selected, onToggle }: Props) {
  const only = selected.length === 1 ? selected[0] : null;
  return (
    <section className="flex flex-col gap-2 rounded-xl border bg-white p-3" aria-label="Top states by upcoming installs">
      <h3 className="font-mono text-[11px] uppercase tracking-wider text-slate-500">Top states by upcoming installs</h3>
      {data.length === 0 ? (
        <p className="py-4 text-center text-sm text-slate-400">No upcoming installs under these filters.</p>
      ) : (
        <>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} layout="vertical" margin={{ left: 4, right: 12, top: 4, bottom: 4 }}>
                <XAxis type="number" allowDecimals={false} hide />
                <YAxis type="category" dataKey="state" width={34} tick={{ fontSize: 11 }} />
                <Tooltip cursor={{ fill: "#f1f5f9" }} formatter={(value) => [value, "Upcoming stores"]} />
                <Bar dataKey="count" radius={[0, 4, 4, 0]} onClick={(entry: { payload?: StateCount }) => entry.payload && onToggle(entry.payload.state)} cursor="pointer">
                  {data.map((row) => (
                    <Cell key={row.state} fill={only === null || only === row.state ? ACTIVE : IDLE} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
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
        </>
      )}
    </section>
  );
}
