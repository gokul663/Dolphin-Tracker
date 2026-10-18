import { useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { actualCounts } from "@/features/stores/details";
import { useUpdateScreens } from "@/features/stores/api";
import { deriveStatus, STOP_STATUSES, type Project, type ScreenStatus, type Stop } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";
import { cn } from "@/lib/utils";

/** One editable row; `key` is local (React), `id` is the server's and is sent back so the row keeps it. */
export interface ScreenRow {
  key: string;
  id?: string;
  stick_number: string;
  venue_id: string;
  screen_size: string;
  is_dolphin_screen: boolean;
  has_mount: boolean;
  has_ceiling_mount: boolean;
  status: ScreenStatus;
}

let nextKey = 0;
export const toRows = (stop: Pick<Stop, "screens">): ScreenRow[] => stop.screens.map((screen) => ({ key: screen.id, ...screen }));

/** STORE-MODEL §4.1: a new row is Upcoming, a Dolphin screen, wall-mounted, no mount yet. */
export const newRow = (): ScreenRow => ({
  key: `new-${(nextKey += 1)}`, stick_number: "", venue_id: "", screen_size: "", is_dolphin_screen: true,
  has_mount: false, has_ceiling_mount: false, status: "Upcoming",
});

export const toInputs = (rows: ScreenRow[]) => rows.map(({ key: _key, ...row }) => row);

/** Screen rows of one store: add, edit, delete (with confirmation), save as a full replace (PUT …/screens). */
export function ScreensEditor({ project, stop }: { project: Project; stop: Stop }) {
  const [rows, setRows] = useState<ScreenRow[]>(() => toRows(stop));
  const [removing, setRemoving] = useState<ScreenRow | null>(null);
  const save = useUpdateScreens(project.id);
  const saved = JSON.stringify(toInputs(toRows(stop)));
  const dirty = JSON.stringify(toInputs(rows)) !== saved;
  const counts = actualCounts(rows);
  const derived = deriveStatus(rows.map((row) => row.status));

  const patch = (key: string, change: Partial<ScreenRow>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));

  const submit = async () => {
    try {
      await save.mutateAsync({ uid: stop.uid, screens: toInputs(rows) });
      toast.success("Screens saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the screens");
    }
  };

  return (
    <section className="space-y-3" aria-label="Screen rows">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-600">
          {rows.length} {rows.length === 1 ? "screen" : "screens"} · {counts.dolphin} Dolphin · {counts.tvs} store TVs · store status{" "}
          <span className={cn("rounded border px-1.5 py-0.5 font-medium", STATUS_META[derived].chip)} data-testid="derived-status">
            {STATUS_META[derived].label}
          </span>
        </p>
        <Button size="sm" variant="outline" onClick={() => setRows((current) => [...current, newRow()])}>
          <Plus /> Add screen
        </Button>
      </div>
      <ul className="space-y-2">
        {rows.map((row, index) => (
          <li key={row.key} className="space-y-2 rounded-lg border p-2.5" aria-label={`Screen ${index + 1}`}>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">#{index + 1}</span>
              <Select value={row.status} onValueChange={(value) => patch(row.key, { status: value as ScreenStatus })}>
                <SelectTrigger size="sm" aria-label={`Status of screen ${index + 1}`} className={cn("h-7 border", STATUS_META[row.status].chip)}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STOP_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      <span className="size-2 rounded-full" style={{ background: STATUS_META[status].color }} />
                      {STATUS_META[status].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="icon"
                variant="ghost"
                className="ml-auto size-7"
                aria-label={`Delete screen ${index + 1}`}
                disabled={rows.length === 1}
                title={rows.length === 1 ? "A store needs at least one screen" : undefined}
                onClick={() => setRemoving(row)}
              >
                <Trash2 />
              </Button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {([["stick_number", "Stick #"], ["venue_id", "DD code"], ["screen_size", "Size"]] as const).map(([key, label]) => (
                <div key={key} className="space-y-1">
                  <Label htmlFor={`${row.key}-${key}`} className="text-[11px] text-slate-500">
                    {label}
                  </Label>
                  <Input id={`${row.key}-${key}`} className="h-8" value={row[key]} onChange={(event) => patch(row.key, { [key]: event.target.value })} />
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {([["is_dolphin_screen", "Dolphin screen"], ["has_mount", "Has mount"], ["has_ceiling_mount", "Ceiling mount"]] as const).map(([key, label]) => (
                <label key={key} className="flex items-center gap-1.5">
                  <Checkbox
                    aria-label={`${label}, screen ${index + 1}`}
                    checked={row[key]}
                    onCheckedChange={(checked) => patch(row.key, { [key]: checked === true })}
                  />
                  {label}
                </label>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={!dirty} onClick={() => setRows(toRows(stop))}>
          Discard
        </Button>
        <Button onClick={submit} disabled={!dirty || save.isPending}>
          {save.isPending && <Loader2 className="animate-spin" />} Save screens
        </Button>
      </div>
      <ConfirmDialog
        open={removing !== null}
        title="Delete this screen?"
        confirmLabel="Delete screen"
        onConfirm={() => {
          setRows((current) => current.filter((row) => row.key !== removing?.key));
          setRemoving(null);
        }}
        onCancel={() => setRemoving(null)}
      >
        {removing ? `Screen ${removing.stick_number || removing.venue_id || "without an id"} is removed when you save.` : ""}
      </ConfirmDialog>
    </section>
  );
}
