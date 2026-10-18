import { useState } from "react";
import { Check, ChevronDown, ChevronUp, ClipboardCopy, Download, Info, Map as MapIcon, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  copyText,
  dayCsvRows,
  dayStateLabel,
  filenameSlug,
  mapsUrlForStops,
  routableStops,
  routeChunks,
  sameAddressRecords,
  stopPAs,
  tally,
  toCsv,
  uniqueCities,
} from "@/features/routes/routeModel";
import { useUpdateScreens, withStatus } from "@/features/stores/api";
import { downloadText } from "@/lib/download";
import { STOP_STATUSES, type Project, type Stop } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";
import { cn } from "@/lib/utils";

interface Props {
  project: Project;
  installer: string;
  color: string;
  day: number;
  totalDays: number;
  stops: Stop[];
  collapsed: boolean;
  onToggle: () => void;
  onEdit: (uid: string) => void;
  onReassign: (stop: Stop, installer: string) => void;
}

export function DayCard({ project, installer, color, day, totalDays, stops, collapsed, onToggle, onEdit, onReassign }: Props) {
  const [showAddresses, setShowAddresses] = useState(false);
  const [copied, setCopied] = useState(false);
  const screens = useUpdateScreens(project.id);
  const active = routableStops(stops);
  const chunks = routeChunks(active);
  const counts = tally(stops);
  const shared = sameAddressRecords(stops);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyText(stops));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Copy failed: the browser blocked clipboard access");
    }
  };

  return (
    <Card className="gap-0 overflow-hidden p-0" style={{ borderTop: `4px solid ${color}` }} aria-label={`${installer}, day ${day}`} role="region">
      <div className="flex items-start justify-between gap-2 p-3">
        <div>
          <div className="font-display text-xl tracking-[2px]" style={{ color }}>
            Day {day} <span className="font-mono text-[10px] tracking-normal opacity-60">of {totalDays}</span>
          </div>
          <Badge variant="outline" className="font-mono text-[10px]">
            {dayStateLabel(stops)}
          </Badge>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex flex-wrap justify-end gap-1 font-mono text-[10px]">
            <span className="rounded bg-emerald-50 px-1.5 text-emerald-700">{counts.complete} done</span>
            <span className="rounded bg-amber-50 px-1.5 text-amber-700">{counts.pending} upcoming</span>
            {counts.offline > 0 && <span className="rounded bg-rose-50 px-1.5 text-rose-700">{counts.offline} offline</span>}
            {counts.other > 0 && <span className="rounded bg-violet-50 px-1.5 text-violet-700">{counts.other} other</span>}
          </div>
          <span className="font-mono text-[10px] text-slate-500">
            {active.length} active · {stops.length} records{shared ? ` · ${shared} same-address` : ""}
          </span>
          <div className="flex gap-1">
            <Button size="icon" variant="ghost" className="size-7" aria-label={`View addresses for ${installer}, day ${day}`} onClick={() => setShowAddresses(true)}>
              <Info />
            </Button>
            <Button size="icon" variant="ghost" className="size-7" aria-expanded={!collapsed} aria-label={collapsed ? "Expand day" : "Collapse day"} onClick={onToggle}>
              {collapsed ? <ChevronDown /> : <ChevronUp />}
            </Button>
          </div>
        </div>
      </div>
      {!collapsed && (
        <>
          <div className="border-y bg-slate-50 px-3 py-1 font-mono text-[10px] text-slate-500">
            {uniqueCities(stops).slice(0, 4).join(" · ") || "—"}
          </div>
          <ol className="divide-y">
            {stops.map((stop, index) => (
              <li key={stop.uid} className="flex gap-2 px-3 py-2 text-sm">
                <span className="w-5 shrink-0 font-mono text-xs text-slate-400">{index + 1}.</span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{stop.store_name}</div>
                      <div className="truncate text-xs text-slate-500">
                        {stop.addr}, {stop.city} {stop.state} {stop.zip}
                      </div>
                      <div className="truncate font-mono text-[10px] text-slate-400">
                        {stop.display_id}
                        {stopPAs(stop).length ? ` · PA ${stopPAs(stop).join(", ")}` : ""}
                        {stop.external_id ? ` · ${stop.external_id}` : ""}
                        {stop.installer_name && stop.installer_name !== installer ? ` · by ${stop.installer_name}` : ""}
                      </div>
                    </div>
                    <Button size="icon" variant="ghost" className="size-7 shrink-0" aria-label={`Edit ${stop.store_name}`} onClick={() => onEdit(stop.uid)}>
                      <Pencil />
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Select
                      value={stop.status}
                      onValueChange={(value) =>
                        screens.mutate(
                          { uid: stop.uid, screens: withStatus(stop, value as Stop["status"]) },
                          { onError: (error) => toast.error(`Status not saved: ${error.message}`) },
                        )
                      }
                    >
                      <SelectTrigger size="sm" aria-label={`Status of ${stop.store_name}`} className={cn("h-7 border", STATUS_META[stop.status].chip)}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STOP_STATUSES.map((status) => (
                          <SelectItem key={status} value={status}>
                            {STATUS_META[status].label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={installer} onValueChange={(value) => value !== installer && onReassign(stop, value)}>
                      <SelectTrigger size="sm" aria-label={`Installer for ${stop.store_name}`} className="h-7">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {project.installers.map((name) => (
                          <SelectItem key={name} value={name}>
                            {name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {stop.additional_task && <Badge variant="outline" className="h-7 text-[10px]">Additional task</Badge>}
                  </div>
                  {stop.comment && <p className="whitespace-pre-wrap text-xs text-slate-600">{stop.comment}</p>}
                </div>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-1.5 border-t p-3">
            {active.length === 0 ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
                <Check size={14} /> Route complete
              </span>
            ) : (
              chunks.map((chunk, index) => (
                <Button key={chunk.start} asChild size="sm" style={{ background: color }} className="text-white hover:opacity-90">
                  <a href={mapsUrlForStops(chunk.stops)} target="_blank" rel="noopener noreferrer">
                    <MapIcon />
                    {chunks.length === 1
                      ? `Open route (${active.length} active ${active.length === 1 ? "stop" : "stops"})`
                      : `Map ${index + 1} (active stops ${chunk.start + 1}–${chunk.end + 1})`}
                  </a>
                </Button>
              ))
            )}
            <Button size="sm" variant="outline" onClick={copy}>
              {copied ? <Check /> : <ClipboardCopy />} {copied ? "Copied!" : "Copy addresses"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                downloadText(toCsv(dayCsvRows(installer, day, stops, project.field_schema)), `${filenameSlug(installer)}_day${day}_route.csv`)
              }
            >
              <Download /> CSV
            </Button>
          </div>
        </>
      )}
      <Dialog open={showAddresses} onOpenChange={setShowAddresses}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {installer} · Day {day}
            </DialogTitle>
            <DialogDescription>
              {stops.length} {stops.length === 1 ? "address" : "addresses"} scheduled for this day.
            </DialogDescription>
          </DialogHeader>
          <ol className="max-h-[60vh] space-y-2 overflow-y-auto">
            {stops.map((stop, index) => (
              <li key={stop.uid} className="flex gap-3 text-sm">
                <span className="font-mono text-slate-400">{index + 1}</span>
                <div>
                  <div className="font-medium">{stop.store_name}</div>
                  <div className="font-mono text-[10px] text-slate-500">PA · {stopPAs(stop).join(", ") || "Not provided"}</div>
                  <div className="text-slate-600">{[stop.addr, stop.city, stop.state, stop.zip].filter(Boolean).join(", ")}</div>
                </div>
              </li>
            ))}
          </ol>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
