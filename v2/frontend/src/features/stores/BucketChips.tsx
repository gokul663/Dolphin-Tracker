import type { FilterOption } from "@/lib/api/types";
import { BUCKET_META, BUCKETS } from "@/lib/status";
import { cn } from "@/lib/utils";

/** The status-group filter, first in the filter card: one chip per group with its store count under the other
 *  filters. It drives the table, the map and the chart alike (the map legend only hides pins). */
export function BucketChips({
  options,
  selected,
  onToggle,
}: {
  options: FilterOption[] | undefined;
  selected: string[];
  onToggle: (bucket: string) => void;
}) {
  const counts = new Map((options ?? []).map((option) => [option.value, option.count]));
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Status filter">
      <span className="mr-1 font-mono text-xs uppercase tracking-[2px] text-slate-500">Status</span>
      {BUCKETS.map((bucket) => {
        const meta = BUCKET_META[bucket];
        const on = selected.includes(bucket);
        const count = counts.get(bucket) ?? 0;
        return (
          <button
            key={bucket}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(bucket)}
            disabled={count === 0 && !on}
            title={`${bucket}: ${meta.members}`}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-xs uppercase tracking-wider transition-colors disabled:opacity-40",
              on ? "text-white shadow-sm" : "bg-white text-slate-700 hover:bg-slate-50",
            )}
            style={on ? { background: meta.color, borderColor: meta.color } : { borderColor: `${meta.color}55` }}
          >
            <span className="size-2.5 rounded-full ring-2 ring-white/70" style={{ background: on ? "#fff" : meta.color }} />
            {bucket}
            <span className={cn("tabular-nums", on ? "text-white/85" : "text-slate-400")}>{count.toLocaleString()}</span>
          </button>
        );
      })}
    </div>
  );
}
