import { AlertTriangle, Loader2, Replace } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DEVICE_TONE, DeviceBadge, reportDay } from "@/features/device/DeviceBits";
import { OVERWRITE_FIELDS } from "@/features/device/DeviceSettings";
import { useIgnoreDeviceAlert, useOverwriteFromDevice } from "@/features/device/api";
import type { OverwriteField, Project, Stop } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const fmt = (lat: number | null, lng: number | null) => (lat === null || lng === null ? "" : `${lat.toFixed(5)}, ${lng.toFixed(5)}`);

/** The device report's values for this store next to the sheet's, with Overwrite per field or all at once, and the
 *  "not in Dolphin data" alert with Ignore (until the next report day). */
export function StoreDeviceSection({ project, stop }: { project: Project; stop: Stop }) {
  const overwrite = useOverwriteFromDevice(project.id);
  const ignore = useIgnoreDeviceAlert(project.id);
  const device = stop.device;
  const missing = stop.needs_attention.includes("not_reporting");
  const day = project.device_sync?.snapshot_date ?? device?.date ?? "";
  const lost = stop.screens.filter((screen) => screen.status === "Completed" && screen.venue_id && !screen.device);

  const rows: { field: OverwriteField | null; label: string; sheet: string; report: string }[] = device
    ? [
        { field: "store_name", label: "Store name", sheet: stop.store_name, report: device.store_name },
        { field: null, label: "CMS name", sheet: "", report: device.venue_name },
        { field: "addr", label: "Address", sheet: stop.addr, report: device.addr },
        { field: "city", label: "City", sheet: stop.city, report: device.city },
        { field: "state", label: "State", sheet: stop.state, report: device.state },
        { field: "zip", label: "ZIP", sheet: stop.zip, report: device.zip },
        { field: "location", label: "Map location", sheet: fmt(stop.lat, stop.lng), report: fmt(device.lat, device.lng) },
      ]
    : [];
  const differing = rows.filter((row) => row.field && row.report && row.report !== row.sheet).map((row) => row.field as OverwriteField);

  const run = (fields: OverwriteField[]) =>
    overwrite.mutate(
      { uid: stop.uid, fields },
      {
        onSuccess: () => toast.success("Saved the Dolphin data value"),
        onError: (error) => toast.error(error instanceof Error ? error.message : "Overwrite failed"),
      },
    );

  if (!device && !missing) return null;
  return (
    <section aria-label="Dolphin data" className={cn("space-y-2 rounded-lg border p-3", DEVICE_TONE.panel)}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-mono text-[11px] uppercase tracking-wider text-cyan-900">Dolphin data</h3>
        {day && <DeviceBadge date={day} />}
        {differing.length > 0 && (
          <Button size="xs" variant="outline" className="ml-auto" disabled={overwrite.isPending} onClick={() => run(differing)}>
            {overwrite.isPending ? <Loader2 className="animate-spin" /> : <Replace />} Overwrite all ({differing.length})
          </Button>
        )}
      </div>
      {missing && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-sm text-amber-900">
          <AlertTriangle size={14} />
          <span className="min-w-0 flex-1">
            Completed, but {lost.map((screen) => screen.venue_id).join(", ") || "its DD code"} is not in the Dolphin data of {reportDay(day)}.
            Check the DD code, or whether the screen is still registered.
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={ignore.isPending}
            onClick={() => ignore.mutate(stop.uid, { onError: (error) => toast.error(error instanceof Error ? error.message : "Could not ignore") })}
          >
            Ignore until the next report
          </Button>
        </div>
      )}
      {device && (
        <table className="w-full text-sm">
          <thead className="text-left font-mono text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="py-1 pr-2 font-normal">Field</th>
              <th className="py-1 pr-2 font-normal">Sheet</th>
              <th className="py-1 pr-2 font-normal">Dolphin data (shown)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const differs = Boolean(row.field && row.report && row.report !== row.sheet);
              return (
                <tr key={row.label} className="border-t border-cyan-100">
                  <td className="py-1 pr-2 text-slate-500">{row.label}</td>
                  <td className={cn("py-1 pr-2", differs && "text-slate-400 line-through")}>{row.sheet || (row.field ? "—" : "")}</td>
                  <td className={cn("py-1 pr-2 font-medium", DEVICE_TONE.text)}>{row.report || <span className="font-normal text-slate-400">no value</span>}</td>
                  <td className="py-1 text-right">
                    {differs && (
                      <Button size="xs" variant="ghost" disabled={overwrite.isPending} onClick={() => run([row.field as OverwriteField])}>
                        Overwrite
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {device && (
        <p className="text-xs text-slate-500">
          The Dolphin data shows on the map and in the list; the sheet value stays underneath until you overwrite it. Fields:{" "}
          {OVERWRITE_FIELDS.map(({ label }) => label).join(", ")}.
        </p>
      )}
    </section>
  );
}
