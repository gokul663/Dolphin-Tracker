import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { OVERLAY_COLORS } from "@/components/map/pins";
import { screenTotals } from "@/features/dashboard/aggregate";
import { STOP_STATUSES, type Kpi, type StopStatus } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";

/** Screen statuses always shown; any other status appears only when some screen has it. */
const SCREEN_STATUSES: StopStatus[] = [
  "Upcoming",
  "Archived",
  "Offline",
  "Completed",
];

/** Project header KPIs (STORE-MODEL §5) in two sections: stores (upcoming, completed and offline by derived status;
 *  partly visited from the visits logged since their latest plan) and
 *  screens (by their own status, with recorded vs committed Dolphin screens and TVs). */
export function ProjectKpis({ kpi, onNeedsAttention }: { kpi: Kpi; onNeedsAttention?: () => void }) {
  const screens = screenTotals([kpi]);
  const visits = kpi.by_visit ?? { none: 0, partly: 0, visited: 0 };
  const share = (count: number, total: number) =>
    total ? `${Math.round((count / total) * 1000) / 10}%` : "";
  const storePct = (count: number) => share(count, kpi.total);
  const screenPct = (count: number) => share(count, kpi.screens_total);
  const screenStatuses = STOP_STATUSES.filter(
    (status) =>
      SCREEN_STATUSES.includes(status) || kpi.screens_by_status[status],
  );
  return (
    <div
      className="flex w-full flex-wrap items-stretch gap-2"
      role="group"
      aria-label="Project KPIs"
    >
      {kpi.needs_attention > 0 && (
        <button
          type="button"
          onClick={onNeedsAttention}
          className="flex flex-col items-center justify-center rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-center text-amber-800 shadow-sm hover:bg-amber-100"
          aria-label={`${kpi.needs_attention} stores need attention`}
          title="Stores needing attention (no name, IBC# or verified address; Completed but not in the Dolphin data; several DD codes in one entry): show them"
        >
          <span className="flex items-center gap-1 text-2xl font-semibold leading-tight tabular-nums">
            <AlertTriangle className="size-5" /> {kpi.needs_attention.toLocaleString()}
          </span>
          <span className="max-w-[10ch] text-balance font-mono text-[10px] uppercase leading-tight tracking-wider">Need attention</span>
        </button>
      )}
      <KpiSection title="Stores" ariaLabel="Store KPIs" tone="stores">
        <KpiCard
          label="Total"
          ariaLabel="Stores"
          value={kpi.total}
          note={`${kpi.pending.toLocaleString()} pending`}
        />
        <KpiCard
          label="Upcoming"
          ariaLabel="Upcoming stores"
          value={kpi.by_status.Upcoming ?? 0}
          note={storePct(kpi.by_status.Upcoming ?? 0)}
          color={STATUS_META.Upcoming.color}
        />
        {(["Completed", "Offline"] as const).map((status) => (
          <KpiCard
            key={status}
            label={STATUS_META[status].label}
            ariaLabel={`${STATUS_META[status].label} stores`}
            value={kpi.by_status[status] ?? 0}
            note={storePct(kpi.by_status[status] ?? 0)}
            color={STATUS_META[status].color}
          />
        ))}
        <KpiCard
          label="Partly visited"
          ariaLabel="Partly visited stores"
          value={visits.partly ?? 0}
          note={storePct(visits.partly ?? 0)}
          color={OVERLAY_COLORS.partly}
        />
      </KpiSection>
      <KpiSection title="Screens" ariaLabel="Screen KPIs" tone="screens">
        <KpiCard
          label="Total"
          ariaLabel="Screens"
          value={kpi.screens_total}
          note={`Dolphin ${screens.actualDolphin} of ${screens.committedDolphin} committed · TVs ${screens.actualTvs} of ${screens.committedTvs}`}
        />
        {screenStatuses.map((status) => (
          <KpiCard
            key={status}
            label={STATUS_META[status].label}
            ariaLabel={`${STATUS_META[status].label} screens`}
            value={kpi.screens_by_status[status] ?? 0}
            note={screenPct(kpi.screens_by_status[status] ?? 0)}
            color={STATUS_META[status].color}
          />
        ))}
      </KpiSection>
    </div>
  );
}

/** Each section is a tinted strip, so stores and screens read as separate groups. */
const TONES = {
  stores: { panel: "border-sky-200 bg-sky-50/80", title: "text-sky-800" },
  screens: {
    panel: "border-violet-200 bg-violet-50/80",
    title: "text-violet-800",
  },
} as const;

function KpiSection({
  title,
  ariaLabel,
  tone,
  children,
}: {
  title: string;
  ariaLabel: string;
  tone: keyof typeof TONES;
  children: ReactNode;
}) {
  const style = TONES[tone];
  return (
    <section
      role="group"
      aria-label={ariaLabel}
      className={`flex min-w-fit flex-1 items-stretch gap-1.5 rounded-xl border p-1.5 ${style.panel}`}
    >
      <h2
        className={`flex items-center px-1.5 font-mono text-[10px] font-semibold uppercase tracking-[2px] ${style.title}`}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

/** v1-style pill: the number on top, the label under it; the share or detail shows on hover. */
function KpiCard({
  label,
  ariaLabel,
  value,
  note,
  color,
}: {
  label: string;
  ariaLabel: string;
  value: number;
  note?: string;
  color?: string;
}) {
  return (
    <div
      className="flex min-w-[76px] flex-1 flex-col items-center justify-center gap-0.5 rounded-lg border bg-white px-3 py-3 text-center shadow-sm"
      aria-label={ariaLabel}
      title={note || undefined}
    >
      <div
        className="text-2xl font-semibold leading-tight tabular-nums"
        style={color ? { color } : undefined}
      >
        {value.toLocaleString()}
      </div>
      <div className="max-w-[10ch] text-balance break-words font-mono text-[10px] uppercase leading-tight tracking-wider text-slate-500">
        {label}
      </div>
    </div>
  );
}
