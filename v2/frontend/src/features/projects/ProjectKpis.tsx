import { AlertTriangle } from "lucide-react";
import { OVERLAY_COLORS } from "@/components/map/pins";
import { screenTotals } from "@/features/dashboard/aggregate";
import type { Kpi } from "@/lib/api/types";
import { BUCKET_META, bucketInk, type StatusBucket } from "@/lib/status";
import { cn } from "@/lib/utils";

/** The status groups in the header, in order: Completed screens are the online ones there. */
const HEADER_BUCKETS: [StatusBucket, string][] = [
  ["Completed", "Online"],
  ["Offline", "Offline"],
  ["Upcoming", "Upcoming"],
  ["Cancelled", "Cancelled"],
];

/** Needs review and Need attention take the same share of the row as every other bubble. */
export const ALERT_BUBBLE_WIDTH = "min-w-[88px] flex-1";

/** Project header KPIs as one row of bubbles: total screens, screens per status group (stores under each), and
 *  the stores needing attention. A status bubble filters the Stores tab
 *  to that group. */
export function ProjectKpis({
  kpi,
  onNeedsAttention,
  onBucket,
  activeBuckets = [],
  leading,
}: {
  kpi: Kpi;
  /** A bubble placed first in the row (the project page's Needs review). */
  leading?: React.ReactNode;
  onNeedsAttention?: () => void;
  /** Toggle the Stores tab's status-group filter. */
  onBucket?: (bucket: StatusBucket) => void;
  activeBuckets?: readonly string[];
}) {
  const screens = screenTotals([kpi]);
  const visits = kpi.by_visit ?? { none: 0, partly: 0, visited: 0 };
  const share = (count: number) => (kpi.screens_total ? `${Math.round((count / kpi.screens_total) * 1000) / 10}%` : "");
  return (
    <div className="flex w-full flex-wrap items-stretch gap-2" role="group" aria-label="Project KPIs">
      {leading}
      {kpi.needs_attention > 0 && (
        <button
          type="button"
          onClick={onNeedsAttention}
          className={cn("flex flex-col items-center justify-center rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-center text-amber-800 shadow-sm hover:bg-amber-100", ALERT_BUBBLE_WIDTH)}
          aria-label={`${kpi.needs_attention} stores need attention`}
          title="Stores needing attention (no name, IBC# or verified address; Completed but not in the Dolphin data; several DD codes in one entry): show them"
        >
          <span className="flex items-center gap-1 text-2xl font-semibold leading-tight tabular-nums">
            <AlertTriangle className="size-5" /> {kpi.needs_attention.toLocaleString()}
          </span>
          <span className="text-balance font-mono text-xs uppercase leading-tight tracking-wider">Need attention</span>
        </button>
      )}
      {/* What the sheet committed (screens + TVs), then what is on the wall ("Completed" = online + offline), then
          each status group. The status bubbles filter the stores; the first two are totals. */}
      <Bubble
        label="Committed"
        ariaLabel="Committed screens and TVs"
        value={(screens.committedDolphin + screens.committedTvs).toLocaleString()}
        sub={`${(kpi.committed_stores ?? 0).toLocaleString()} stores`}
        note={`From the sheet: ${screens.committedDolphin} Dolphin screens · ${screens.committedTvs} store TVs (${kpi.total} stores in the project)`}
        color="#0F5B7C"
      />
      <Bubble
        label="Completed"
        ariaLabel="Completed screens"
        value={(kpi.installed_screens ?? 0).toLocaleString()}
        sub={`${(kpi.installed_stores ?? 0).toLocaleString()} stores`}
        note="Installed: online and offline screens together (and any serviced that need more work)"
        color={BUCKET_META.Completed.dark}
      />
      {HEADER_BUCKETS.map(([bucket, label]) => {
        const count = kpi.screens_by_bucket?.[bucket] ?? 0;
        const stores = kpi.by_bucket?.[bucket] ?? 0;
        return (
          <Bubble
            key={bucket}
            label={label}
            ariaLabel={`${label} screens`}
            value={count.toLocaleString()}
            sub={`${stores.toLocaleString()} stores`}
            note={`${share(count)} of screens · ${BUCKET_META[bucket].members}${onBucket ? " · click to filter the stores" : ""}`}
            color={bucketInk(bucket)}
            active={activeBuckets.includes(bucket)}
            onClick={onBucket ? () => onBucket(bucket) : undefined}
          />
        );
      })}
      {(visits.partly ?? 0) > 0 && (
        <Bubble
          label="Partly visited"
          ariaLabel="Partly visited stores"
          value={(visits.partly ?? 0).toLocaleString()}
          note="Stores with some sticks visited since their latest plan"
          color={OVERLAY_COLORS.partly}
        />
      )}
    </div>
  );
}

/** A big number over a small caps label (the Atlanta header), with an optional second line. */
function Bubble({
  label,
  ariaLabel,
  value,
  sub,
  note,
  color,
  active = false,
  onClick,
}: {
  label: string;
  ariaLabel: string;
  value: string;
  sub?: string;
  note?: string;
  color: string;
  active?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="text-3xl font-semibold leading-tight tabular-nums" style={{ color: active ? "#fff" : color }}>
        {value}
      </span>
      <span className={cn("text-balance font-mono text-xs font-medium uppercase leading-tight tracking-wider", active ? "text-white/90" : "text-slate-500")}>
        {label}
      </span>
      {sub && <span className={cn("font-mono text-xs leading-tight", active ? "text-white/75" : "text-slate-400")}>{sub}</span>}
    </>
  );
  const className = cn(
    "flex min-w-[88px] flex-1 flex-col items-center justify-center gap-0.5 rounded-xl border bg-white px-3 py-2 text-center shadow-sm",
    onClick && "cursor-pointer transition-colors hover:bg-slate-50",
    active && "hover:opacity-90",
  );
  const style = active ? { background: color, borderColor: color } : { borderColor: `${color}40` };
  return onClick ? (
    <button type="button" aria-label={ariaLabel} aria-pressed={active} title={note} onClick={onClick} className={className} style={style}>
      {body}
    </button>
  ) : (
    <div aria-label={ariaLabel} title={note} className={className} style={style}>
      {body}
    </div>
  );
}
