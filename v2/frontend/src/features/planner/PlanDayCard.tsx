import { useState } from "react";
import { Check, ChevronDown, ChevronUp, ClipboardCheck, ClipboardCopy, Download, Map as MapIcon, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  copyAddresses,
  dayMapsLinks,
  dayMiles,
  fullAddress,
  isVisited,
  planCsv,
  planStopKey,
  type PlanDayView,
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
  onOpen: (stop: PlanStop) => void;
  onReassign: (stop: PlanStop, installer: string) => void;
  onRemove: (stop: PlanStop) => void;
}

const KIND_LABEL = { past: "Done", current: "Today", forecast: "Forecast" } as const;

/** One installer's day in a plan: stops in order, visit state, live status, route links and exports. */
export function PlanDayCard({ bundle, installer, color, day, active, onOpen, onReassign, onRemove }: Props) {
  const [collapsed, setCollapsed] = useState(day.kind === "past");
  const [copied, setCopied] = useState(false);
  const open = day.stops.filter((stop) => !isVisited(stop));
  const visited = day.stops.length - open.length;
  const links = dayMapsLinks(day.kind === "forecast" ? null : day.start, open);
  const names = bundle.plan.installers.map((i) => i.name);
  const label = `${installer}, day ${day.number}`;

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
      className={cn("gap-0 overflow-hidden p-0", day.kind === "current" && "ring-2 ring-brand/40", day.kind === "forecast" && "border-dashed")}
      style={{ borderTop: `4px solid ${color}` }}
    >
      <div className="flex items-start justify-between gap-2 p-3">
        <div>
          <div className="font-display text-xl tracking-[2px]" style={{ color }}>
            Day {day.number}
            {day.date && <span className="ml-2 font-mono text-[11px] tracking-normal text-slate-500">{day.date}</span>}
          </div>
          <Badge variant={day.kind === "current" ? "default" : "outline"} className="font-mono text-[10px]">
            {KIND_LABEL[day.kind]}
          </Badge>
        </div>
        <div className="flex flex-col items-end gap-1 font-mono text-[10px] text-slate-500">
          <span>
            {day.stops.length} stops · {visited} visited · {dayMiles(day.stops, day.start)} mi
          </span>
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
              const done = isVisited(stop);
              const canEdit = active && !done;
              return (
                <li key={planStopKey(stop)} className={cn("flex gap-2 px-3 py-2 text-sm", done && "bg-emerald-50/40")}>
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
                      {done ? (
                        <span className="inline-flex h-6 items-center gap-1 rounded-md bg-emerald-100 px-2 text-[11px] font-medium text-emerald-800">
                          <Check size={12} /> Visited
                        </span>
                      ) : stop.visited_screens.length > 0 ? (
                        <span className="inline-flex h-6 items-center rounded-md bg-amber-100 px-2 text-[11px] text-amber-800">
                          {stop.visited_screens.length}/{stop.screen_ids.length} sticks visited
                        </span>
                      ) : null}
                      {active && !done && (
                        <Button size="xs" variant="outline" onClick={() => onOpen(stop)}>
                          <ClipboardCheck /> Log visit
                        </Button>
                      )}
                      {canEdit && names.length > 1 && (
                        <Select value={installer} onValueChange={(value) => value !== installer && onReassign(stop, value)}>
                          <SelectTrigger size="sm" aria-label={`Installer for ${stop.store_name}`} className="h-6 text-[11px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {names.map((name) => (
                              <SelectItem key={name} value={name}>
                                {name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      {canEdit && stop.visited_screens.length === 0 && (
                        <Button size="icon-xs" variant="ghost" aria-label={`Remove ${stop.store_name} from the plan`} onClick={() => onRemove(stop)}>
                          <Trash2 />
                        </Button>
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
