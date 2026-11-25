import { AlertTriangle, Inbox } from "lucide-react";
import { OVERLAY_COLORS } from "@/components/map/pins";
import { screenTotals } from "@/features/dashboard/aggregate";
import type { Kpi } from "@/lib/api/types";
import { BUCKET_LABEL, BUCKET_META, bucketInk, type StatusBucket } from "@/lib/status";
import { cn } from "@/lib/utils";

/** The status groups in the header's second set, in order: Completed screens are the online ones there. */
const HEADER_BUCKETS: StatusBucket[] = ["Completed", "Offline", "Not Registered", "Cancelled", "Archived"];

/** Project header KPIs as two sets of bubbles: the totals (Committed, Completed, Upcoming, Needs review, Need
 *  attention), then a gap and the screens by status (Online, Offline, Not Registered, Cancelled, Archived, stores
 *  under each). On a narrow window the statuses drop to a second line together. A status bubble filters the Stores
 *  tab to that group. */
export function ProjectKpis({
  kpi,
  reviewCount = 0,
  onDeviceReview,
  onMissingScreens,
  onNeedsAttention,
  onBucket,
  activeBuckets = [],
}: {
  kpi: Kpi;
  /** Screens the Dolphin data reports for this PA that are in no store here. */
  reviewCount?: number;
  onDeviceReview?: () => void;
  /** Show the done stores with fewer screens than committed. */
  onMissingScreens?: () => void;
  onNeedsAttention?: () => void;
  /** Toggle the Stores tab's status-group filter. */
  onBucket?: (bucket: StatusBucket) => void;
  activeBuckets?: readonly string[];
}) {
  const screens = screenTotals([kpi]);
  const visits = kpi.by_visit ?? { none: 0, partly: 0, visited: 0 };
  const share = (count: number) => (kpi.screens_total ? `${Math.round((count / kpi.screens_total) * 1000) / 10}%` : "");
  const missing = kpi.review_screens ?? 0;
  const review = reviewCount + missing;
  const reviewParts = [reviewCount > 0 && `${reviewCount.toLocaleString()} new`, missing > 0 && `${missing.toLocaleString()} missing`].filter(Boolean);
  const statusBubble = (bucket: StatusBucket) => {
    const count = kpi.screens_by_bucket?.[bucket] ?? 0;
    // The stores under a screen group: for Not Registered screens, the stores that read In Progress.
    const storeBucket: StatusBucket = bucket === "Not Registered" ? "In Progress" : bucket;
    const stores = kpi.by_bucket?.[storeBucket] ?? 0;
    const label = BUCKET_LABEL[bucket];
    return (
      <Bubble
        key={bucket}
        label={label}
        ariaLabel={`${label} screens`}
        value={count.toLocaleString()}
        sub={`${stores.toLocaleString()} stores`}
        note={`${share(count)} of screens · ${BUCKET_META[bucket].members}${storeBucket === bucket ? "" : " (its stores read In Progress)"}${onBucket ? " · click to filter the stores" : ""}`}
        color={bucketInk(bucket)}
        active={activeBuckets.includes(storeBucket)}
        onClick={onBucket ? () => onBucket(storeBucket) : undefined}
      />
    );
  };
  const group = "flex min-w-[min(100%,30rem)] flex-1 items-stretch gap-2";
  return (
    <div className="flex w-full flex-wrap items-stretch gap-x-6 gap-y-2" role="group" aria-label="Project KPIs">
      {/* What the sheet committed (screens + TVs), what is on the wall ("Completed" = online + offline), what is
          still to come, and what someone has to look at. */}
      <div className={group} role="group" aria-label="Totals">
        <Bubble
          label="Committed"
          ariaLabel="Committed screens and TVs"
          value={(screens.committedDolphin + screens.committedTvs).toLocaleString()}
          sub={`${(kpi.committed_stores ?? 0).toLocaleString()} stores`}
          note={`From the sheet: ${screens.committedDolphin} Dolphin screens · ${screens.committedTvs} store TVs`}
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
        {statusBubble("Upcoming")}
        <AlertBubble
          label="Needs review"
          count={review}
          sub={reviewParts.join(" · ")}
          icon={<Inbox className="size-5" />}
          tone="cyan"
          ariaLabel={`${review} screens need review`}
          title="Screens the Dolphin data reports for this PA that are in no store here, and committed screens missing at stores that read as done (Completed or Offline with fewer screen rows than the sheet committed)"
          onClick={reviewCount > 0 ? onDeviceReview : onMissingScreens}
        />
        <AlertBubble
          label="Need attention"
          count={kpi.needs_attention}
          icon={<AlertTriangle className="size-5" />}
          tone="amber"
          ariaLabel={`${kpi.needs_attention} stores need attention`}
          title="Stores needing attention (no name, ExtID or verified address; Completed but not in the Dolphin data; several DD codes in one entry): show them"
          onClick={onNeedsAttention}
        />
      </div>
      <div className={group} role="group" aria-label="Screens by status">
        {HEADER_BUCKETS.map(statusBubble)}
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
    </div>
  );
}

const ALERT_TONES = {
  cyan: "border-cyan-300 bg-cyan-50 text-cyan-900 hover:bg-cyan-100",
  amber: "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100",
};

/** Needs review / Need attention: tinted while there is something to look at, plain and inert at 0, so the row
 *  keeps its shape. */
function AlertBubble({
  label,
  count,
  sub,
  icon,
  tone,
  ariaLabel,
  title,
  onClick,
}: {
  label: string;
  count: number;
  sub?: string;
  icon: React.ReactNode;
  tone: keyof typeof ALERT_TONES;
  ariaLabel: string;
  title: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={count === 0 || !onClick}
      aria-label={ariaLabel}
      title={title}
      className={cn(
        "flex min-w-[88px] flex-1 flex-col items-center justify-center gap-0.5 rounded-xl border px-3 py-2 text-center shadow-sm",
        count > 0 ? ALERT_TONES[tone] : "border-slate-200 bg-white text-slate-400",
      )}
    >
      <span className="flex items-center gap-1 text-3xl font-semibold leading-tight tabular-nums">
        {icon} {count.toLocaleString()}
      </span>
      <span className="text-balance font-mono text-xs font-medium uppercase leading-tight tracking-wider">{label}</span>
      {sub && <span className="text-balance font-mono text-xs leading-tight opacity-75">{sub}</span>}
    </button>
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
