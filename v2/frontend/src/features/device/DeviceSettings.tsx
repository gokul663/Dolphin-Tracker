import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DEVICE_TONE, DeviceBadge } from "@/features/device/DeviceBits";
import { useDevicePas, useOverwriteFromDevice, useSyncNow } from "@/features/device/api";
import { useUpdateProject } from "@/features/projects/api";
import { SectionTitle } from "@/features/settings/DetailsSection";
import type { OverwriteField, Project } from "@/lib/api/types";
import { cn } from "@/lib/utils";

export const OVERWRITE_FIELDS: { field: OverwriteField; label: string }[] = [
  { field: "store_name", label: "Store name" },
  { field: "addr", label: "Address" },
  { field: "city", label: "City" },
  { field: "state", label: "State" },
  { field: "zip", label: "ZIP" },
  { field: "location", label: "Map location" },
];

/** Settings: which PA in the device report this project follows, the last sync, Sync now, Overwrite all. */
export function DeviceSettings({ project }: { project: Project }) {
  const pas = useDevicePas();
  const [pa, setPa] = useState(project.device_pa);
  useEffect(() => setPa(project.device_pa), [project.device_pa]);
  const update = useUpdateProject(project.id);
  const sync = useSyncNow(project.id);
  const overwrite = useOverwriteFromDevice(project.id);
  const [fields, setFields] = useState<Set<OverwriteField>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const state = project.device_sync;
  const known = pas.data?.pas ?? [];
  const unknownPa = pa.trim() !== "" && pas.isSuccess && !known.includes(pa.trim());

  const savePa = async () => {
    try {
      await update.mutateAsync({ device_pa: pa.trim(), expected_version: project.version });
      if (!pa.trim()) return toast.success("Device sync turned off for this project");
      const result = await sync.mutateAsync();
      toast.success(`Synced with ${pa.trim()}: ${result.state?.matched_screens ?? 0} screens matched`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save");
    }
  };
  const syncNow = () =>
    sync.mutate(undefined, {
      onSuccess: (result) => toast.success(`Synced: ${result.state?.status_changes ?? 0} status changes, ${result.state?.review_count ?? 0} to review`),
      onError: (error) => toast.error(error instanceof Error ? error.message : "Sync failed"),
    });
  const runOverwrite = () =>
    overwrite.mutate(
      { fields: [...fields] },
      {
        onSuccess: (result) => {
          toast.success(`${result.stores_updated} stores now use the Dolphin data values`);
          setFields(new Set());
        },
        onError: (error) => toast.error(error instanceof Error ? error.message : "Overwrite failed"),
      },
    );

  return (
    <Card className={cn("gap-4 p-5", DEVICE_TONE.panel)}>
      <SectionTitle
        title="Dolphin device data"
        hint="Sync this project with its PA in the CMS device report: work status follows Online / Offline / Archived, and the report's name, address and location show over the sheet's (in this colour)."
      />
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-72 flex-1 space-y-1.5">
          <Label htmlFor="device-pa">Sync with PA</Label>
          <Input
            id="device-pa"
            list="device-pa-options"
            placeholder={pas.isPending ? "Loading PA names…" : "Pick the PA name as the CMS writes it"}
            value={pa}
            onChange={(event) => setPa(event.target.value)}
          />
          <datalist id="device-pa-options">
            {known.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          {pas.isError && <p className="text-xs text-rose-700">Could not load the PA list: {pas.error.message}</p>}
          {unknownPa && <p className="text-xs text-amber-700">Not a PA name in the report's latest day; nothing would match.</p>}
        </div>
        <Button onClick={() => void savePa()} disabled={pa.trim() === project.device_pa || update.isPending || sync.isPending}>
          {(update.isPending || sync.isPending) && <Loader2 className="animate-spin" />} {pa.trim() ? "Save and sync" : "Turn off"}
        </Button>
      </div>
      {project.device_pa && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
          {state ? (
            <>
              <DeviceBadge date={state.snapshot_date} />
              <span>
                {state.matched_screens} screens matched · {state.status_changes} status changes last sync · {state.review_count} to review ·{" "}
                {state.not_reporting} not in Dolphin data · synced {state.synced_at.slice(0, 16).replace("T", " ")} UTC
              </span>
            </>
          ) : (
            <span className="text-slate-500">Not synced yet.</span>
          )}
          <Button size="sm" variant="outline" className="ml-auto" onClick={syncNow} disabled={sync.isPending}>
            {sync.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Sync now
          </Button>
        </div>
      )}
      {state && (
        <div className="space-y-2 border-t border-cyan-200 pt-3">
          <p className="text-sm font-medium">Overwrite the sheet values with the Dolphin data, for every synced store</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {OVERWRITE_FIELDS.map(({ field, label }) => (
              <label key={field} className="flex items-center gap-1.5">
                <Checkbox
                  checked={fields.has(field)}
                  onCheckedChange={(checked) =>
                    setFields((current) => {
                      const next = new Set(current);
                      if (checked === true) next.add(field);
                      else next.delete(field);
                      return next;
                    })
                  }
                />
                {label}
              </label>
            ))}
            <Button size="sm" variant="outline" className="ml-auto" disabled={fields.size === 0 || overwrite.isPending} onClick={() => setConfirming(true)}>
              {overwrite.isPending && <Loader2 className="animate-spin" />} Overwrite all
            </Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title="Overwrite the sheet values?"
        confirmLabel="Overwrite"
        onConfirm={() => {
          setConfirming(false);
          runOverwrite();
        }}
        onCancel={() => setConfirming(false)}
      >
        {`${OVERWRITE_FIELDS.filter(({ field }) => fields.has(field)).map(({ label }) => label).join(", ")} of every store with Dolphin data is replaced by the report's value. Stores the report has no value for keep theirs. This cannot be undone.`}
      </ConfirmDialog>
    </Card>
  );
}
