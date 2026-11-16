import { useState } from "react";
import { HardHat, Monitor, Plus, Trash2, Tv } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { actualCounts, screenTechnicians } from "@/features/stores/details";
import { useVisits } from "@/features/visits/api";
import { DEVICE_TONE, ScreenDeviceLine, splitCodes } from "@/features/device/DeviceBits";
import { AlertTriangle } from "lucide-react";
import { deriveStatus, STOP_STATUSES, type Project, type ScreenStatus, type Stop } from "@/lib/api/types";
import { BUCKET_META, BUCKETS, bucketOf, STATUS_META } from "@/lib/status";
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
  needs_mount: boolean;
  status: ScreenStatus;
}

let nextKey = 0;
export const toRows = (stop: Pick<Stop, "screens">): ScreenRow[] =>
  stop.screens.map(({ device: _device, status_changed_at: _changed, ...screen }) => ({ key: screen.id, ...screen }));

/** A Dolphin TV is 24", 43" or 50" (24" unless picked; the server holds to it too); store TVs can be any size. */
export const DOLPHIN_SCREEN_SIZE = '24"';
export const DOLPHIN_SIZES = [24, 43, 50] as const;

/** A Dolphin TV's size as one of its three tiles; always one is chosen (24" by default). */
function DolphinSizePicker({ value, onChange, screen }: { value: string; onChange: (value: string) => void; screen: number }) {
  const inches = Number(/^\s*(\d{2})/.exec(value)?.[1] ?? 24);
  const current = (DOLPHIN_SIZES as readonly number[]).includes(inches) ? inches : 24;
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={`Size of screen ${screen}`}>
      {DOLPHIN_SIZES.map((size) => {
        const Icon = size <= 32 ? Monitor : Tv;
        const selected = current === size;
        return (
          <button
            key={size}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={`${size} inch`}
            onClick={() => onChange(`${size}"`)}
            className={cn(
              "flex h-14 w-14 flex-col items-center justify-center gap-1 rounded-lg border-2 text-slate-600 transition-colors",
              selected ? "border-brand bg-brand/5 text-brand shadow-sm" : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50",
            )}
          >
            <Icon size={12 + (size - 24) / 4} strokeWidth={1.6} />
            <span className="font-mono text-sm font-semibold leading-none">{size}″</span>
          </button>
        );
      })}
      <span className="ml-1 text-xs text-slate-500">Dolphin TVs come in 24, 43 and 50 inch</span>
    </div>
  );
}

/** STORE-MODEL §4.1: a new row is Upcoming, a Dolphin screen (so 24"), wall-mounted, no mount yet. */
export const newRow = (): ScreenRow => ({
  key: `new-${(nextKey += 1)}`, stick_number: "", venue_id: "", screen_size: DOLPHIN_SCREEN_SIZE, is_dolphin_screen: true,
  has_mount: false, has_ceiling_mount: false, needs_mount: false, status: "Upcoming",
});

/** The usual sizes, as big tiles: a monitor icon for the small ones, a TV for the rest. */
export const SCREEN_SIZES = [24, 32, 43, 55, 65] as const;
const sizeLabel = (inches: number) => `${inches}"`;

/** The preset a stored size matches ("24", 24", "24in", "24 inch"), or null for anything else. */
export function presetOf(value: string): number | null {
  const match = /^\s*(\d{2})\s*(?:"|″|''|in(?:ch(?:es)?)?\.?)?\s*$/i.exec(value);
  const inches = match ? Number(match[1]) : NaN;
  return (SCREEN_SIZES as readonly number[]).includes(inches) ? inches : null;
}

function SizePicker({ id, value, onChange, screen }: { id: string; value: string; onChange: (value: string) => void; screen: number }) {
  const preset = presetOf(value);
  const [other, setOther] = useState(value !== "" && preset === null);
  const tile = (selected: boolean) =>
    cn(
      "flex h-14 w-14 flex-col items-center justify-center gap-1 rounded-lg border-2 text-slate-600 transition-colors",
      selected ? "border-brand bg-brand/5 text-brand shadow-sm" : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50",
    );
  return (
    <div className="space-y-1.5" role="radiogroup" aria-label={`Size of screen ${screen}`}>
      <div className="flex flex-wrap gap-1.5">
        {SCREEN_SIZES.map((inches) => {
          const Icon = inches <= 32 ? Monitor : Tv;
          const selected = !other && preset === inches;
          return (
            <button
              key={inches}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${inches} inch`}
              className={tile(selected)}
              onClick={() => {
                setOther(false);
                onChange(selected ? "" : sizeLabel(inches));
              }}
            >
              <Icon size={12 + (inches - 24) / 4} strokeWidth={1.6} />
              <span className="font-mono text-sm font-semibold leading-none">{inches}″</span>
            </button>
          );
        })}
        <button
          type="button"
          role="radio"
          aria-checked={other}
          aria-label="Other size"
          className={tile(other)}
          onClick={() => {
            setOther(true);
            if (preset !== null) onChange("");
          }}
        >
          <Tv size={14} strokeWidth={1.6} className="opacity-60" />
          <span className="font-mono text-xs font-semibold leading-none">Other</span>
        </button>
      </div>
      {other && (
        <Input id={id} className="h-8 w-40" placeholder='e.g. 75" or 98"' aria-label={`Other size, screen ${screen}`} value={value} onChange={(event) => onChange(event.target.value)} />
      )}
    </div>
  );
}

/** Who has visited this screen, from the visit log: the latest technician and date, then anyone else. Read only. */
function ScreenTechnicians({ last, all, screen }: { last: { name: string; date: string } | null; all: string[]; screen: number }) {
  const others = all.filter((name) => name !== last?.name);
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-slate-600" aria-label={`Technicians, screen ${screen}`}>
      <HardHat size={12} className="text-slate-400" />
      {last ? (
        <>
          <span>
            Last visited by <span className="font-medium text-slate-800">{last.name}</span> on {last.date}
          </span>
          {others.length > 0 && <span className="text-slate-500">· also {others.join(", ")}</span>}
        </>
      ) : (
        <span className="text-slate-400">No technician visit logged yet</span>
      )}
    </p>
  );
}

export const toInputs = (rows: ScreenRow[]) => rows.map(({ key: _key, ...row }) => row);

/** The suggested fix for an entry holding several DD codes: one row per code, its stick at the same position when
 *  the counts match; the first keeps the row's id. Applied only when the person presses Split (then Save). */
export function splitSuggestion(row: ScreenRow): ScreenRow[] {
  const codes = splitCodes(row.venue_id);
  const sticks = splitCodes(row.stick_number);
  const paired = sticks.length === codes.length;
  return codes.map((code, index) => ({
    ...(index === 0 ? row : { ...newRow(), status: row.status, screen_size: row.screen_size, is_dolphin_screen: row.is_dolphin_screen }),
    venue_id: code,
    stick_number: paired ? sticks[index]! : index === 0 ? row.stick_number : "",
  }));
}

/** Whether the draft rows differ from the saved ones (the store window's single Save sends them). */
export const screensChanged = (stop: Pick<Stop, "screens">, rows: ScreenRow[]) =>
  JSON.stringify(toInputs(rows)) !== JSON.stringify(toInputs(toRows(stop)));

/** Screen rows of one store as a draft: add, edit, delete (with confirmation). The store window saves them with
 *  everything else, as a full replace (PUT …/screens). */
export function ScreensEditor({ project, stop, rows, onChange }: { project: Project; stop: Stop; rows: ScreenRow[]; onChange: (rows: ScreenRow[]) => void }) {
  const [removing, setRemoving] = useState<ScreenRow | null>(null);
  const setRows = (next: (current: ScreenRow[]) => ScreenRow[]) => onChange(next(rows));
  const counts = actualCounts(rows);
  const derived = deriveStatus(rows.map((row) => row.status));
  const devices = new Map(stop.screens.map((screen) => [screen.id, screen.device]));
  const visits = useVisits(project.id, stop.uid).data?.items ?? [];

  const patch = (key: string, change: Partial<ScreenRow>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));

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
                  {BUCKETS.map((bucket) => (
                    <SelectGroup key={bucket}>
                      <SelectLabel className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider" style={{ color: BUCKET_META[bucket].color }}>
                        {bucket}
                      </SelectLabel>
                      {STOP_STATUSES.filter((status) => bucketOf(status) === bucket).map((status) => (
                        <SelectItem key={status} value={status}>
                          <span className="size-2 rounded-full" style={{ background: STATUS_META[status].color }} />
                          {STATUS_META[status].label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
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
            {row.id && devices.get(row.id) && <ScreenDeviceLine device={devices.get(row.id)!} />}
            {row.id && <ScreenTechnicians {...screenTechnicians(visits, row.id)} screen={index + 1} />}
            {splitCodes(row.venue_id).length > 1 && (
              <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
                <AlertTriangle size={13} />
                <span className="min-w-0 flex-1">
                  This DD code entry holds {splitCodes(row.venue_id).length} codes, so it matches no device. Suggestion:{" "}
                  {splitSuggestion(row)
                    .map((part) => (part.stick_number ? `${part.venue_id} (stick ${part.stick_number})` : part.venue_id))
                    .join("; ")}
                  .
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => setRows((current) => current.flatMap((item) => (item.key === row.key ? splitSuggestion(item) : [item])))}
                >
                  Split into {splitCodes(row.venue_id).length} screens
                </Button>
              </div>
            )}
            {row.is_dolphin_screen ? (
              <DolphinSizePicker screen={index + 1} value={row.screen_size} onChange={(screen_size) => patch(row.key, { screen_size })} />
            ) : (
              <SizePicker id={`${row.key}-screen_size`} screen={index + 1} value={row.screen_size} onChange={(screen_size) => patch(row.key, { screen_size })} />
            )}
            <div className="grid grid-cols-2 gap-2">
              {([["stick_number", "Stick #"], ["venue_id", "DD code"]] as const).map(([key, label]) => (
                <div key={key} className="space-y-1">
                  <Label htmlFor={`${row.key}-${key}`} className="text-[11px] text-slate-500">
                    {label}
                  </Label>
                  <Input id={`${row.key}-${key}`} className="h-8" value={row[key]} onChange={(event) => patch(row.key, { [key]: event.target.value })} />
                  {key === "stick_number" && row.id && devices.get(row.id)?.serial_number && devices.get(row.id)!.serial_number !== row.stick_number && (
                    <p className={cn("text-[11px]", DEVICE_TONE.text)}>Dolphin data: {devices.get(row.id)!.serial_number} (shown)</p>
                  )}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
              {([["is_dolphin_screen", "Dolphin TV"], ["has_mount", "Has mount"], ["has_ceiling_mount", "Ceiling mount"]] as const).map(([key, label]) => (
                <label key={key} className="flex items-center gap-1.5">
                  <Checkbox
                    aria-label={`${label}, screen ${index + 1}`}
                    checked={row[key]}
                    onCheckedChange={(checked) =>
                      key === "is_dolphin_screen"
                        ? // A Dolphin screen is 24"; a store TV starts without a size until one is picked.
                          patch(row.key, { is_dolphin_screen: checked === true, screen_size: checked === true ? DOLPHIN_SCREEN_SIZE : "" })
                        : patch(row.key, { [key]: checked === true })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </li>
        ))}
      </ul>
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

/** Stick #: the Dolphin data's serial number when it has one (it wins, in the Dolphin colour, the sheet's value on
 *  hover), else what the sheet or a person entered. */
function StickNumber({ sheet, serial }: { sheet: string; serial?: string | null }) {
  const fromDolphin = Boolean(serial?.trim());
  const shown = fromDolphin ? serial!.trim() : sheet;
  return (
    <span
      className={cn("font-mono", fromDolphin ? DEVICE_TONE.text : "text-slate-800")}
      title={fromDolphin ? `From the Dolphin data${sheet && sheet !== shown ? ` (sheet: ${sheet})` : ""}` : undefined}
      aria-label={`Stick number${fromDolphin ? " (Dolphin data)" : ""}`}
    >
      {shown || <span className="text-slate-300">—</span>}
    </span>
  );
}

const yesNo = (value: boolean) => (value ? "Yes" : "No");
const dash = <span className="text-slate-300">—</span>;

/** The Dolphin data's word on one screen, short: its status (and days offline); the rest on hover. */
function DolphinCell({ device }: { device?: Stop["screens"][number]["device"] }) {
  if (!device) return dash;
  const seen = device.last_seen ? device.last_seen.slice(0, 16).replace("T", " ") : "";
  const detail = [device.venue_name, device.serial_number, seen && `last seen ${seen}`, `report ${device.date}`].filter(Boolean).join(" · ");
  const online = device.status.toLowerCase() === "online";
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", DEVICE_TONE.text)} title={detail}>
      <span className={cn("size-2 rounded-full", online ? "bg-emerald-500" : device.status.toLowerCase() === "offline" ? "bg-rose-500" : "bg-amber-400")} />
      {device.status || "Unknown"}
      {device.offline_days ? <span className="text-slate-500">· {device.offline_days} d</span> : null}
    </span>
  );
}

/** The screens as a table (the store window's default view): one row per screen, its kind, size and mount as
 *  plain values. The window's Edit turns them all into the editor. Shows the draft rows, so changes not saved yet
 *  are visible here too. */
export function ScreensView({ project, stop, rows }: { project: Project; stop: Stop; rows: ScreenRow[] }) {
  const devices = new Map(stop.screens.map((screen) => [screen.id, screen.device]));
  const visits = useVisits(project.id, stop.uid).data?.items ?? [];
  const counts = actualCounts(rows);
  const derived = deriveStatus(rows.map((row) => row.status));
  const head = "px-2 py-1.5 text-left font-mono text-[11px] font-normal uppercase tracking-wider text-slate-500";
  return (
    <section className="space-y-2" aria-label="Screen list">
      <p className="text-xs text-slate-600">
        {rows.length} {rows.length === 1 ? "screen" : "screens"} · {counts.dolphin} Dolphin · {counts.tvs} store TVs · store status{" "}
        <span className={cn("rounded border px-1.5 py-0.5 font-medium", STATUS_META[derived].chip)}>{STATUS_META[derived].label}</span>
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm" aria-label="Screens">
          <thead className="border-b bg-slate-50">
            <tr>
              <th className={head}>#</th>
              <th className={head}>Status</th>
              <th className={head}>Screen</th>
              <th className={head}>Size</th>
              <th className={head}>Has mount</th>
              <th className={head}>Ceiling mount</th>
              <th className={head}>Stick #</th>
              <th className={head}>DD code</th>
              <th className={head}>Dolphin data</th>
              <th className={head}>Last visit</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row, index) => {
              const Icon = row.is_dolphin_screen ? Monitor : Tv;
              const visited = row.id ? screenTechnicians(visits, row.id) : { last: null, all: [] };
              return (
                <tr key={row.key} aria-label={`Screen ${index + 1}`} className="align-middle">
                  <td className="px-2 py-2 font-mono text-xs text-slate-500">{index + 1}</td>
                  <td className="px-2 py-2">
                    <span className={cn("inline-block w-[92px] truncate rounded border px-1.5 py-0.5 text-center text-xs font-medium", STATUS_META[row.status].chip)} title={STATUS_META[row.status].label}>
                      {STATUS_META[row.status].label}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-2">
                    <span className="inline-flex items-center gap-1.5">
                      <Icon size={14} className="text-slate-500" />
                      {row.is_dolphin_screen ? "Dolphin TV" : "Store TV"}
                    </span>
                  </td>
                  <td className="px-2 py-2 font-mono">{(row.is_dolphin_screen ? row.screen_size || DOLPHIN_SCREEN_SIZE : row.screen_size) || dash}</td>
                  <td className="px-2 py-2" aria-label={`Has mount, screen ${index + 1}`}>{yesNo(row.has_mount)}</td>
                  <td className="px-2 py-2" aria-label={`Ceiling mount, screen ${index + 1}`}>{row.has_mount ? yesNo(row.has_ceiling_mount) : dash}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-xs">
                    <StickNumber sheet={row.stick_number} serial={row.id ? devices.get(row.id)?.serial_number : undefined} />
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 font-mono text-xs">{row.venue_id || dash}</td>
                  <td className="px-2 py-2 text-xs">
                    <DolphinCell device={row.id ? devices.get(row.id) : null} />
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-xs" title={visited.all.length > 1 ? `Also: ${visited.all.filter((name) => name !== visited.last?.name).join(", ")}` : undefined}>
                    {visited.last ? (
                      <>
                        <span className="font-medium text-slate-800">{visited.last.name}</span> <span className="text-slate-500">{visited.last.date}</span>
                      </>
                    ) : (
                      dash
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
