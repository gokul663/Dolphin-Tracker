import { useCan } from "@/lib/auth/me";
import { useState } from "react";
import { ArrowRightLeft, Check, ChevronDown, ChevronUp, ClipboardCheck, ClipboardCopy, Download, Lock, LockOpen, Map as MapIcon, Pin, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  copyAddresses,
  dayMapsLinks,
  dayDriveMinutes,
  dayLimits,
  dayMiles,
  formatDuration,
  fullAddress,
  isVisited,
  planCsv,
  planStopKey,
  STOP_STATE_LABEL,
  STOP_STATES,
  stopState,
  type PlanDayView,
  type StopState,
} from "@/features/planner/planModel";
import { filenameSlug } from "@/features/routes/routeModel";
import { downloadText } from "@/lib/download";
import type { PlanStop, RoutePlanBundle, StopStatus } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";
import { cn } from "@/lib/utils";

interface Props {
  bundle: RoutePlanBundle;
  installer: string;
  color: string;
  day: PlanDayView;
  active: boolean;
  /** Open the store to write a log entry for the visit. */
  onOpen: (stop: PlanStop) => void;
  /** Open "Move": another day, installer or plan, or remove. */
  onMove: (stop: PlanStop) => void;
  /** Mark the stop Done / Incomplete / back to in route. */
  onMark: (stop: PlanStop, state: StopState) => void;
  onUnpin: (stop: PlanStop) => void;
  /** Only an older plan's locked day still shows this, to unlock it. */
  onUnlock: () => void;
  onAdd: () => void;
  /** This day is the one the map is showing. */
  picked: boolean;
  /** Show only this day on the map (again: every day). */
  onPick: () => void;
}

const KIND_LABEL = { past: "Done", current: "Today", forecast: "Forecast" } as const;
const STATE_TONE: Record<StopState, string> = {
  done: "border-emerald-300 bg-emerald-50 text-emerald-800",
  incomplete: "border-amber-300 bg-amber-50 text-amber-800",
  route: "border-sky-300 bg-sky-50 text-sky-800",
};

/** One installer's day in a plan: stops in order, visit state, live status, route links and exports. */
export function PlanDayCard({ bundle, installer, color, day, active, onOpen, onMove, onMark, onUnpin, onUnlock, onAdd, picked, onPick }: Props) {
  const [collapsed, setCollapsed] = useState(day.kind === "past");
  const canArrange = useCan("routes.arrange"); // another day or installer, Done / Incomplete
  const canManage = useCan("routes.manage"); // stores into the plan
  const canLog = useCan("visits.log");
  const editable = active && day.kind !== "past";
  const locked = bundle.plan.locked_days.some((lock) => lock.installer === installer && lock.day === day.number);
  const [copied, setCopied] = useState(false);
  const open = day.stops.filter((stop) => !isVisited(stop));
  const visited = day.stops.length - open.length;
  const links = dayMapsLinks(day.kind === "forecast" ? null : day.start, open);
  const label = `${installer}, day ${day.number}`;
  const drive = dayDriveMinutes(day.stops);
  const limits = dayLimits(bundle.plan, day.kind === "forecast" ? undefined : day.number, installer);
  const limit = limits.hours * 60;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyAddresses(day.stops));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Copy failed: the browser blocked clipboard access");
    }
  };

  return (
    <Card
      role="region"
      aria-label={label}
      className={cn("gap-0 overflow-hidden p-0", day.kind === "current" && "ring-2 ring-brand/40", day.kind === "forecast" && "border-dashed", picked && "ring-2 ring-slate-900")}
      style={{ borderTop: `4px solid ${color}` }}
    >
      <div className="flex items-start justify-between gap-2 p-3">
        <div className="shrink-0">
          <button
            type="button"
            aria-pressed={picked}
            aria-label={picked ? `Show every day on the map (now only ${label})` : `Show only ${label} on the map`}
            title={picked ? "Click to show every day on the map again" : "Click to show only this day on the map"}
            onClick={onPick}
            className="whitespace-nowrap rounded-md px-1.5 text-left font-display text-xl tracking-[2px] hover:bg-slate-100"
            style={picked ? { background: color, color: "#fff" } : { color }}
          >
            Day {day.number}
            {day.date && <span className={cn("ml-2 font-mono text-[11px] tracking-normal", picked ? "text-white/85" : "text-slate-500")}>{day.date}</span>}
          </button>
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant={day.kind === "current" ? "default" : "outline"} className="font-mono text-[10px]">
              {KIND_LABEL[day.kind]}
            </Badge>
            {locked && (
              <Badge variant="outline" className="gap-1 border-amber-300 bg-amber-50 font-mono text-[10px] text-amber-800">
                <Lock className="size-3" /> Locked
              </Badge>
            )}
          </div>
          {editable && locked && canArrange && (
            <div className="mt-2">
              <Button size="xs" variant="outline" aria-label={`Unlock ${label}`} title="Unlock: recalculations may change this day again" onClick={onUnlock}>
                <LockOpen /> Unlock
              </Button>
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 font-mono text-[10px] text-slate-500">
          <span>
            {day.stops.length} stops · {visited} done · {dayMiles(day.stops, day.start)} mi
          </span>
          {drive !== null && (
            <span aria-label="Driving time" className={cn(limit > 0 && drive > limit && "font-semibold text-amber-700")}>
              ≈ {formatDuration(drive)} driving{limit > 0 ? ` of ${formatDuration(limit)} max` : ""}
            </span>
          )}
          {day.start && day.kind !== "forecast" && <span className="max-w-56 truncate">from {day.start.address}</span>}
          <Button size="icon" variant="ghost" className="size-7" aria-expanded={!collapsed} aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`} onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? <ChevronDown /> : <ChevronUp />}
          </Button>
        </div>
      </div>
      {!collapsed && (
        <>
          <ol className="divide-y border-t">
            {day.stops.map((stop, index) => {
              const status = (bundle.store_status[planStopKey(stop)] ?? "Upcoming") as StopStatus;
              const state = stopState(stop);
              // Every stick has a log entry: Done by its visits, not by a mark that could be taken back.
              const byVisits = stop.screen_ids.length > 0 && stop.screen_ids.every((id) => stop.visited_screens.includes(id));
              return (
                <li key={planStopKey(stop)} className={cn("flex gap-2 px-3 py-2 text-sm", state === "done" && "bg-emerald-50/40", state === "incomplete" && "bg-amber-50/50")}>
                  <span className="w-5 shrink-0 font-mono text-xs text-slate-400">{index + 1}.</span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <button type="button" className="block w-full text-left" onClick={() => onOpen(stop)} aria-label={`Open ${stop.store_name}`}>
                      <div className="truncate font-medium hover:underline">{stop.store_name}</div>
                      <div className="truncate text-xs text-slate-500">{fullAddress(stop)}</div>
                      <div className="truncate font-mono text-[10px] text-slate-400">
                        {bundle.project_names[stop.project_id] ?? stop.project_id}
                        {stop.external_id ? ` · ${stop.external_id}` : ""}
                      </div>
                    </button>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={cn("inline-flex h-6 items-center rounded-md border px-2 text-[11px]", STATUS_META[status]?.chip)}>{status}</span>
                      {active && !byVisits && canArrange ? (
                        <Select value={state} onValueChange={(next) => next !== state && onMark(stop, next as StopState)}>
                          <SelectTrigger size="sm" aria-label={`Visit of ${stop.store_name}`} className={cn("h-6 text-[11px] font-medium", STATE_TONE[state])}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {STOP_STATES.map((option) => (
                              <SelectItem key={option} value={option}>
                                {STOP_STATE_LABEL[option]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <span className={cn("inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] font-medium", STATE_TONE[state])}>
                          {state === "done" && <Check size={12} />} {STOP_STATE_LABEL[state]}
                        </span>
                      )}
                      {state !== "done" && stop.visited_screens.length > 0 && (
                        <span className="inline-flex h-6 items-center rounded-md bg-amber-100 px-2 text-[11px] text-amber-800">
                          {stop.visited_screens.length}/{stop.screen_ids.length} sticks logged
                        </span>
                      )}
                      {active && canLog && (
                        <Button size="xs" variant="outline" onClick={() => onOpen(stop)}>
                          <ClipboardCheck /> Log entry
                        </Button>
                      )}
                      {active && canArrange && state !== "done" && (
                        <Button size="xs" variant="outline" aria-label={`Move ${stop.store_name}`} onClick={() => onMove(stop)}>
                          <ArrowRightLeft /> Move
                        </Button>
                      )}
                      {stop.pinned && state !== "done" && (
                        <span className="inline-flex h-6 items-center gap-1 rounded-md border border-slate-300 bg-slate-50 pl-1.5 pr-0.5 text-[11px] text-slate-700" title="Put on this day by hand: recalculations leave it here">
                          <Pin size={11} /> Kept on this day
                          {active && canArrange && (
                            <button type="button" aria-label={`Let ${stop.store_name} be recalculated again`} className="rounded p-0.5 hover:bg-slate-200" onClick={() => onUnpin(stop)}>
                              <X size={11} />
                            </button>
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="flex flex-wrap gap-1.5 border-t p-3">
            {open.length === 0 ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
                <Check size={14} /> Every stop visited
              </span>
            ) : (
              links.map((link) => (
                <Button key={link.url} asChild size="sm" style={{ background: color }} className="text-white hover:opacity-90">
                  <a href={link.url} target="_blank" rel="noopener noreferrer">
                    <MapIcon /> {link.label}
                  </a>
                </Button>
              ))
            )}
            {editable && canManage && (
              <Button size="sm" variant="outline" onClick={onAdd} title="You choose where it goes, between which stores">
                <Plus /> Add store
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => void copy()}>
              {copied ? <Check /> : <ClipboardCopy />} {copied ? "Copied!" : "Copy addresses"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => downloadText(planCsv(bundle, day.stops), `${filenameSlug(installer)}_day${day.number}_route.csv`)}
            >
              <Download /> CSV
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
