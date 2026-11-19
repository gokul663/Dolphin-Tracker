import { useState } from "react";
import { Link } from "react-router";
import { AlertTriangle, Check, MapPin, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { nameKey } from "@/features/installers/InstallerName";
import { useInstallers } from "@/features/lists/api";
import { MaxHoursField } from "@/features/planner/MaxHoursField";
import { parseMaxHours, todayIso } from "@/features/planner/planModel";
import { StartLocationField } from "@/features/planner/StartLocationField";
import { installerColor } from "@/features/routes/routeModel";
import type { StartLocation } from "@/lib/api/types";

export interface InstallerDraft {
  name: string;
  start: StartLocation | null;
  /** This installer's stops per day. */
  perDay: number;
  /** Their longest driving day, as typed: blank = no limit. */
  maxHours: string;
  /** The first date they work on this plan (YYYY-MM-DD). */
  startDate: string;
}

export const emptyInstaller = (): InstallerDraft => ({ name: "", start: null, perDay: 10, maxHours: "", startDate: todayIso() });

/** What the API takes for one installer. */
export const installerBody = (row: InstallerDraft) => ({
  name: row.name.trim(),
  start: row.start!,
  stops_per_day: row.perDay,
  max_day_hours: parseMaxHours(row.maxHours) ?? 0,
  start_date: row.startDate,
});

/** The plan's first day: the earliest date any of its installers starts. */
export const firstStartDate = (rows: InstallerDraft[]) => rows.map((row) => row.startDate).filter(Boolean).sort()[0] ?? todayIso();

/** What is wrong with one installer, in the order the form asks for it ("" when it can be added). */
export function draftProblem(draft: InstallerDraft, others: InstallerDraft[] = []): string {
  const name = nameKey(draft.name);
  if (!name) return "Choose the installer.";
  if (others.some((row) => nameKey(row.name) === name)) return `${draft.name.trim()} is already on this plan.`;
  if (!draft.start) return "Type their starting location and pick it from the list.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.startDate)) return "Choose the date they start.";
  if (!(draft.perDay >= 1 && draft.perDay <= 50)) return "Stops per day is between 1 and 50.";
  if (parseMaxHours(draft.maxHours) === null) return "Max driving is between 0 and 24 hours, or blank.";
  return "";
}

/** Problems that block saving the list. */
export function installerProblems(rows: InstallerDraft[]): string[] {
  if (!rows.length) return ["Add at least one installer."];
  return rows.map((row, index) => draftProblem(row, rows.filter((_, i) => i !== index))).filter(Boolean);
}

/** The installers of a plan: each one added is a line (name, start, stops per day, max driving) with Edit and
 *  Remove; "Add installer" opens the form for the next one, as screens are added to a store. The installer is
 *  picked from the Installers page's list only: someone new is added there first. */
export function InstallerRows({ rows, onChange }: { rows: InstallerDraft[]; onChange: (rows: InstallerDraft[]) => void }) {
  // Which line's form is open: an index, "new" for the add form, null for none.
  const [editing, setEditing] = useState<number | "new" | null>(rows.length === 0 ? "new" : null);
  const names = rows.map((row) => row.name);
  return (
    <div className="space-y-3">
      {rows.length > 0 && (
        <ol className="divide-y rounded-xl border bg-white" aria-label="Installers on this plan">
          {rows.map((row, index) =>
            editing === index ? (
              <li key={index} className="p-3">
                <InstallerForm
                  title={`Edit ${row.name}`}
                  initial={row}
                  others={rows.filter((_, i) => i !== index)}
                  submitLabel="Save"
                  onCancel={() => setEditing(null)}
                  onSubmit={(next) => {
                    onChange(rows.map((current, i) => (i === index ? next : current)));
                    setEditing(null);
                  }}
                />
              </li>
            ) : (
              <InstallerLine
                key={index}
                row={row}
                color={installerColor(names, row.name)}
                onEdit={() => setEditing(index)}
                onRemove={() => {
                  onChange(rows.filter((_, i) => i !== index));
                  setEditing(rows.length === 1 ? "new" : null);
                }}
              />
            ),
          )}
        </ol>
      )}
      {editing === "new" ? (
        <div className="rounded-xl border bg-white p-3">
          <InstallerForm
            title={rows.length === 0 ? "Add the first installer" : "Add an installer"}
            initial={{ ...emptyInstaller(), perDay: rows.at(-1)?.perDay ?? 10, maxHours: rows.at(-1)?.maxHours ?? "", startDate: rows.at(-1)?.startDate ?? todayIso() }}
            others={rows}
            submitLabel="Add installer"
            onCancel={rows.length > 0 ? () => setEditing(null) : undefined}
            onSubmit={(next) => {
              onChange([...rows, next]);
              setEditing(null);
            }}
          />
        </div>
      ) : (
        <Button variant="outline" onClick={() => setEditing("new")} disabled={rows.length >= 50}>
          <Plus /> Add installer
        </Button>
      )}
    </div>
  );
}

function InstallerLine({ row, color, onEdit, onRemove }: { row: InstallerDraft; color: string; onEdit: () => void; onRemove: () => void }) {
  const installers = useInstallers();
  const listed = installers.data ? installers.data.some((item) => nameKey(item.value) === nameKey(row.name)) : true;
  const hours = parseMaxHours(row.maxHours);
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 text-sm" aria-label={row.name}>
      <span className="flex min-w-36 items-center gap-2 font-semibold text-slate-900">
        <span className="size-3 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
        {row.name}
        {!listed && (
          <span title={`${row.name} is not in the Installers list: add them on the Installers page`} className="text-amber-600">
            <AlertTriangle size={13} aria-label={`${row.name} is not in the Installers list`} />
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-slate-600">
        <MapPin size={14} className="shrink-0 text-slate-400" />
        {row.start ? <span className="truncate">{row.start.address}</span> : <span className="text-amber-700">No starting location</span>}
      </span>
      <span className="whitespace-nowrap font-mono text-xs text-slate-600">
        starts {row.startDate} · {row.perDay} stops/day · {hours ? `max ${hours} h driving` : "no driving limit"}
      </span>
      <span className="ml-auto flex shrink-0">
        <Button size="icon" variant="ghost" className="size-8" aria-label={`Edit ${row.name}`} onClick={onEdit}>
          <Pencil />
        </Button>
        <Button size="icon" variant="ghost" className="size-8" aria-label={`Remove ${row.name}`} onClick={onRemove}>
          <Trash2 />
        </Button>
      </span>
    </li>
  );
}

interface FormProps {
  title: string;
  initial: InstallerDraft;
  others: InstallerDraft[];
  submitLabel: string;
  onSubmit: (draft: InstallerDraft) => void;
  onCancel?: () => void;
}

function InstallerForm({ title, initial, others, submitLabel, onSubmit, onCancel }: FormProps) {
  const installers = useInstallers();
  const [draft, setDraft] = useState(initial);
  const taken = new Set(others.map((row) => nameKey(row.name)));
  const listed = (installers.data ?? []).filter((item) => !taken.has(nameKey(item.value)));
  const inList = listed.find((item) => nameKey(item.value) === nameKey(draft.name));
  const unlisted = Boolean(initial.name) && installers.data !== undefined && !inList;
  const [asked, setAsked] = useState(false); // the submit was tried: say what is missing
  const problem = draftProblem(draft, others);
  const set = (patch: Partial<InstallerDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const submit = () => {
    setAsked(true);
    if (!problem) onSubmit({ ...draft, name: inList?.value ?? draft.name.trim() });
  };
  return (
    <div className="space-y-3" role="group" aria-label={title}>
      <h3 className="font-mono text-[11px] uppercase tracking-wider text-slate-600">{title}</h3>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="installer-pick">Installer</Label>
            {unlisted ? (
              // An older plan's installer who is not on the Installers page: kept as they are, not pickable here.
              <p id="installer-pick" className="flex h-9 items-center gap-1.5 rounded-md border bg-slate-50 px-3 text-sm font-medium text-slate-900">
                {draft.name} <AlertTriangle size={13} className="text-amber-600" aria-label={`${draft.name} is not in the Installers list`} />
              </p>
            ) : (
              <Select value={inList?.value ?? ""} onValueChange={(value) => set({ name: value })}>
                <SelectTrigger id="installer-pick" aria-label="Installer" className="w-full">
                  <SelectValue placeholder={installers.isPending ? "Loading installers…" : listed.length ? "Select an installer" : "No installer left to add"} />
                </SelectTrigger>
                <SelectContent>
                  {listed.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {inList ? (
              <p className="text-xs text-slate-500">{[inList.phone, inList.email].filter(Boolean).join(" · ") || "No phone or email on the Installers page yet"}</p>
            ) : (
              <p className="text-xs text-slate-500">
                {unlisted ? "Not in the Installers list. Add them on the " : "Someone new? Add them on the "}
                <Link to="/installers" target="_blank" className="text-brand underline">
                  Installers page
                </Link>
                {unlisted ? "." : " first; they then show here."}
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
            <div className="space-y-1.5">
              <Label htmlFor="installer-start-date">Start date</Label>
              <Input id="installer-start-date" type="date" value={draft.startDate} onChange={(event) => set({ startDate: event.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="installer-per-day">Stops per day</Label>
              <Input id="installer-per-day" type="number" min={1} max={50} value={Number.isFinite(draft.perDay) ? draft.perDay : ""} onChange={(event) => set({ perDay: event.target.value === "" ? Number.NaN : Number(event.target.value) })} />
            </div>
            <MaxHoursField id="installer-max-hours" value={draft.maxHours} onChange={(maxHours) => set({ maxHours })} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Starting location (home or hotel)</Label>
          <StartLocationField label={draft.name.trim() ? `Starting location for ${draft.name.trim()}` : "Starting location"} value={draft.start} onChange={(start) => set({ start })} map />
          {!draft.start && <p className="text-xs text-slate-500">Type an address and pick it from the list: it is looked up and shown on a map here.</p>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={submit}>
          {submitLabel === "Save" ? <Check /> : <Plus />} {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        {asked && problem && (
          <p className="text-xs text-amber-700" role="alert">
            {problem}
          </p>
        )}
      </div>
    </div>
  );
}
