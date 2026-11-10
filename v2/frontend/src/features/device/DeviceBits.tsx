import { Radio } from "lucide-react";
import type { ScreenDevice } from "@/lib/api/types";
import { cn } from "@/lib/utils";

/** One colour for everything that comes from the CMS device report, so it reads apart from the sheet's values. */
export const DEVICE_TONE = {
  text: "text-cyan-800",
  chip: "border-cyan-200 bg-cyan-50 text-cyan-800",
  panel: "border-cyan-200 bg-cyan-50/50",
};

/** The report's day (YYYY-MM-DD) as the CMS writes it: MM-DD. */
export const reportDay = (date: string) => (date.length >= 10 ? `${date.slice(5, 7)}-${date.slice(8, 10)}` : date);

export function DeviceBadge({ date, className }: { date: string; className?: string }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium", DEVICE_TONE.chip, className)}
      title={`From the Dolphin device report of ${date}`}
    >
      <Radio size={10} /> Dolphin data · {reportDay(date)}
    </span>
  );
}

const ONLINE = { Online: "bg-emerald-500", Offline: "bg-rose-500", Archived: "bg-slate-400" } as Record<string, string>;

/** A screen's report status: a dot, the status, how long offline, last seen. */
export function ScreenDeviceLine({ device }: { device: ScreenDevice }) {
  const seen = device.last_seen ? device.last_seen.slice(0, 16).replace("T", " ") : "";
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px]", DEVICE_TONE.chip)}>
      <span className={cn("size-2 rounded-full", ONLINE[device.status] ?? "bg-amber-400")} />
      <span className="font-medium">{device.status || "Unknown"}</span>
      {device.offline_days ? <span>· offline {device.offline_days} d</span> : null}
      {seen && <span>· last seen {seen}</span>}
      {device.venue_name && <span className="font-mono">· {device.venue_name}</span>}
      {device.serial_number && <span className="font-mono">· {device.serial_number}</span>}
      <span className="opacity-70">({reportDay(device.date)})</span>
    </span>
  );
}

export { splitCodes } from "@/lib/codes";
