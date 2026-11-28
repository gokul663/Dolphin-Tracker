import { useEffect, useRef } from "react";
import { AlertTriangle, Check, Monitor, Tv } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { SuggestInput } from "@/components/SuggestInput";
import { Label } from "@/components/ui/label";
import { actualCounts, fulfillment, hardwareCost, INSTALLED_STATUSES, money, sizeLabel, type HardwareCosts } from "@/features/stores/details";
import { nameKey, NotAnInstaller } from "@/features/installers/InstallerName";
import { useInstallers } from "@/features/lists/api";
import type { ScreenRow } from "@/features/stores/ScreensEditor";
import { cn } from "@/lib/utils";
import { EditToggle, ToneChip } from "@/features/stores/SectionChrome";
import { SECTION_TONE, type ToneName } from "@/features/stores/sectionTone";

export const SELF_INSTALL = "Self install";
export const REP_INSTALL = "Rep install";
/** Install types that send no technician: the store or a rep installs. */
export const NO_TECHNICIAN: ReadonlySet<string> = new Set([SELF_INSTALL, REP_INSTALL]);
const INSTALL_CHOICES = ["Technician", SELF_INSTALL, REP_INSTALL] as const;

export const COUNT_KEYS = [
  "committed_dolphin_screens",
  "committed_store_tvs",
  "wall_24_mounts_needed",
  "wall_mounts_needed",
  "ceiling_mounts_needed",
  "tv_mounts_needed",
  "mounts_used",
] as const;
export type CountKey = (typeof COUNT_KEYS)[number];

/** The store window's draft for the top strip; nothing here is saved until the window's Save. */
export interface SummaryDraft {
  /** The typed counts, as their input text ("" = not known). */
  counts: Record<CountKey, string>;
  errors: Partial<Record<CountKey, string>>;
  /** The draft screen rows (installed is counted from them). */
  rows: ScreenRow[];
  technician: string;
  installType: string;
}

/** The three mount pieces, in the card's order: the 24 inch wall mount is its own piece. */
const MOUNTS = [
  { kind: "wall_24", field: "wall_24_mounts_needed", label: "Wall 24″" },
  { kind: "wall", field: "wall_mounts_needed", label: "Wall" },
  { kind: "ceiling", field: "ceiling_mounts_needed", label: "Ceiling" },
] as const;
type MountKind = (typeof MOUNTS)[number]["kind"];

/** A mount is still to bring while its screen is not on the wall: the Upcoming group except Serviced - Needs More
 *  Work (on the wall), and Not Registered. Mirrors the backend's `store_counts.MOUNT_NEEDED_STATUSES`. */
const MOUNT_NEEDED_STATUSES: ReadonlySet<string> = new Set(["Upcoming", "Invitation Email Sent", "Shipped", "Delivered", "Not Registered"]);

/** Mounts to bring per piece, worked out from the screens: a mount picked and the screen not installed yet. Mirrors
 *  the backend's `store_counts.computed_mounts_needed` (the saved store carries the result as
 *  `effective_mounts_needed`); kept here so the window shows the draft's numbers before Save. */
export function computedMounts(rows: Pick<ScreenRow, "status" | "has_mount" | "has_ceiling_mount" | "screen_size">[]): Record<MountKind, number> {
  const counts = { wall_24: 0, wall: 0, ceiling: 0 };
  for (const row of rows) {
    if (!row.has_mount || !MOUNT_NEEDED_STATUSES.has(row.status)) continue;
    counts[row.has_ceiling_mount ? "ceiling" : (sizeLabel(row.screen_size) || '24"') === '24"' ? "wall_24" : "wall"] += 1;
  }
  return counts;
}

/** Mounts on the wall, worked out from the screens: a mount picked and the screen installed (Completed, Offline,
 *  Serviced - Needs More Work). Mirrors the backend's `store_counts.computed_mounts_used` (saved as
 *  `effective_mounts_used`). */
export function computedMountsUsed(rows: Pick<ScreenRow, "status" | "has_mount">[]): number {
  return rows.filter((row) => row.has_mount && INSTALLED_STATUSES.has(row.status)).length;
}

/** Mounts on the wall per piece: a mount picked and the screen installed, sorted into the same pieces as
 *  `computedMounts` (ceiling, else the 24 inch wall mount for a 24″ or unknown size, else a wall mount). Its total is
 *  `computedMountsUsed`. */
export function computedMountsUsedByPiece(rows: Pick<ScreenRow, "status" | "has_mount" | "has_ceiling_mount" | "screen_size">[]): Record<MountKind, number> {
  const counts = { wall_24: 0, wall: 0, ceiling: 0 };
  for (const row of rows) {
    if (!row.has_mount || !INSTALLED_STATUSES.has(row.status)) continue;
    counts[row.has_ceiling_mount ? "ceiling" : (sizeLabel(row.screen_size) || '24"') === '24"' ? "wall_24" : "wall"] += 1;
  }
  return counts;
}

const toNumber = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);

/** One compact card of the top strip: a micro-label title (with what sits on its right) over a few tight rows. */
const CARD = "flex min-w-0 flex-col gap-1.5 rounded-xl bg-white px-3.5 py-2.5 shadow-sm ring-1 ring-slate-900/5";

/** The top of the store window, four compact cards: the screens (committed and installed, together), the hardware
 *  cost (left out when the project hides it), the mounts to bring and on the wall per piece, and who installs. The
 *  committed counts read as numbers until the card's Edit, like a section; everything is a draft until the window's
 *  Save. */
export function StoreSummary({
  draft,
  costs,
  technicians,
  editingCommitted,
  onEditCommitted,
  onCount,
  onTechnician,
  onInstallType,
}: {
  draft: SummaryDraft;
  /** The project's hardware prices (Settings). */
  costs: HardwareCosts;
  technicians: string[];
  /** The committed counts show as inputs (the card's Edit / View); an invalid count keeps them shown regardless. */
  editingCommitted: boolean;
  onEditCommitted: (on: boolean) => void;
  onCount: (key: CountKey, text: string) => void;
  onTechnician: (name: string) => void;
  /** "Technician", "Self install" or "Rep install". */
  onInstallType: (type: string) => void;
}) {
  const { counts } = draft;
  const done = fulfillment({
    screens: draft.rows,
    committed_dolphin_screens: toNumber(counts.committed_dolphin_screens),
    committed_store_tvs: toNumber(counts.committed_store_tvs),
  });
  const rows = actualCounts(draft.rows);
  const cost = costs.hidden ? null : hardwareCost(draft.rows, costs);
  const committedErrors = (["committed_dolphin_screens", "committed_store_tvs"] as const).filter((key) => draft.errors[key]);
  // An invalid count forces the inputs open, so the problem is in sight (as a section's form stays open).
  const editing = editingCommitted || committedErrors.length > 0;
  // …and keeps them open once fixed, so clearing the bad value does not snap the boxes shut mid-typing.
  const forced = committedErrors.length > 0;
  useEffect(() => {
    if (forced && !editingCommitted) onEditCommitted(true);
  }, [forced, editingCommitted, onEditCommitted]);
  // Edit moves the focus into the first box; set by the button, so a forced open leaves the focus alone.
  const focusFirst = useRef(false);
  const firstInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing && focusFirst.current) firstInput.current?.focus();
    focusFirst.current = false;
  }, [editing]);
  const count = (key: CountKey, label: string, icon: React.ReactNode, inputRef?: React.Ref<HTMLInputElement>) => (
    <CountInput field={key} label={label} icon={icon} value={counts[key]} error={draft.errors[key]} inputRef={inputRef} onChange={(text) => onCount(key, text)} />
  );
  // Green once the commitment is met: something committed, and at least as many installed (the stores table's rule).
  // Green when what is installed is equal to or more than what was committed. A blank committed count is 0, so
  // anything installed meets it.
  const fulfilled = done.fulfilled;
  return (
    <div
      className={cn(
        "grid gap-3 sm:grid-cols-2",
        cost ? "xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.25fr)]" : "xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1.2fr)_minmax(0,1.25fr)]",
      )}
      aria-label="Store summary"
    >
      <section aria-label="Screens: committed and installed" className={cn(CARD, fulfilled && "bg-green-50 ring-green-300")}>
        <CardTitle
          title="Screens"
          tone="Screens"
          fulfilled={fulfilled}
          hint={`Screen rows: ${rows.dolphin} ${rows.dolphin === 1 ? "screen" : "screens"} · ${rows.tvs} ${rows.tvs === 1 ? "TV" : "TVs"}`}
          right={
            <span className="flex items-center gap-2">
              <span className={cn("flex items-center gap-1 text-xs tabular-nums", fulfilled ? "font-medium text-green-800" : "text-slate-600")}>
                {fulfilled && <Check size={14} className="text-green-700" aria-label="Fulfilled" />}
                <span title="Installed: Completed, Offline or Needs More Work. A blank committed count is 0.">{`${done.installed} of ${done.committed} committed`}</span>
              </span>
              <EditToggle
                label="committed counts"
                editing={editing}
                disabled={committedErrors.length > 0}
                className="h-7 px-2 text-xs"
                onEdit={() => {
                  focusFirst.current = true;
                  onEditCommitted(true);
                }}
                onView={() => onEditCommitted(false)}
              />
            </span>
          }
        />
        <div className="grid grid-cols-[4.75rem_minmax(0,1fr)_2.25rem] items-center gap-x-2 gap-y-1.5">
          <div role="group" aria-label="Committed" className="contents">
            <span className="text-xs text-slate-600">Committed</span>
            <div className="flex min-w-0 gap-2 text-sm">
              {editing ? (
                <>
                  {count("committed_dolphin_screens", "Screens", <Monitor size={13} />, firstInput)}
                  {count("committed_store_tvs", "TVs", <Tv size={13} />)}
                </>
              ) : (
                <>
                  <Figure icon={<Monitor size={13} />} label="Screens" value={counts.committed_dolphin_screens.trim() || "0"} ariaLabel="Committed screens" />
                  <Figure icon={<Tv size={13} />} label="TVs" value={counts.committed_store_tvs.trim() || "0"} ariaLabel="Committed TVs" />
                </>
              )}
            </div>
            <Total value={sum(toNumber(counts.committed_dolphin_screens), toNumber(counts.committed_store_tvs)) ?? 0} label="Committed total" />
          </div>
          <div role="group" aria-label="Installed" className="contents">
            <span className="text-xs text-slate-600" title="Completed, Offline or Needs More Work">
              Installed
            </span>
            <div className="flex min-w-0 gap-2 text-sm">
              <Figure icon={<Monitor size={13} />} label="Screens" value={done.installedScreens} ariaLabel="Installed screens" />
              <Figure icon={<Tv size={13} />} label="TVs" value={done.installedTvs} ariaLabel="Installed TVs" />
            </div>
            <Total value={done.installed} label="Installed total" tone={fulfilled ? "text-green-800" : undefined} />
          </div>
        </div>
        {committedErrors.map((key) => (
          <p key={key} id={`store-count-${key}-error`} className="text-xs text-rose-700">
            {draft.errors[key]}
          </p>
        ))}
        {done.committed > 0 && (
          <div className="h-1 overflow-hidden rounded-full bg-slate-100" aria-hidden>
            <div className={cn("h-full rounded-full", fulfilled ? "bg-green-600" : "bg-brand")} style={{ width: `${Math.round(Math.min(1, done.installed / done.committed) * 100)}%` }} />
          </div>
        )}
      </section>
      {cost && <HardwareCard cost={cost} />}
      <MountsCard rows={draft.rows} />
      <AssignmentCard technician={draft.technician} installType={draft.installType} technicians={technicians} onTechnician={onTechnician} onInstallType={onInstallType} />
    </div>
  );
}

const sum = (...values: (number | null)[]) =>
  values.every((value) => value === null) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0);

/** The cards' heading: the app's mono micro-label beside the card's icon chip, both in the card's hue
 *  (sectionTone.ts); green throughout once the Screens card is fulfilled. */
function CardTitle({ title, tone, fulfilled = false, hint, right }: { title: string; tone: ToneName; fulfilled?: boolean; hint?: string; right?: React.ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-2">
      <h3 className={cn("flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-wider", fulfilled ? "text-green-900" : SECTION_TONE[tone].title)} title={hint}>
        <ToneChip name={tone} className={fulfilled ? "bg-green-100 text-green-700" : undefined} />
        {title}
      </h3>
      {right}
    </div>
  );
}

function Total({ value, label, tone }: { value: number | null; label: string; tone?: string }) {
  return (
    <span className={cn("text-right text-lg font-semibold leading-none tabular-nums", tone ?? "text-slate-900")} aria-label={label}>
      {value === null ? <span className="font-normal text-slate-400">—</span> : value}
    </span>
  );
}

/** A number beside an icon, the same footprint as a count box so the two rows line up ("" reads as a dash). */
function Figure({ icon, label, value, ariaLabel }: { icon: React.ReactNode; label: string; value: number | string; ariaLabel: string }) {
  return (
    <span className="flex h-8 min-w-0 flex-1 items-center gap-1.5 px-1 text-slate-600" title={label}>
      {icon}
      <span className="sr-only">{label}</span>
      <span className="font-medium tabular-nums text-slate-900" aria-label={ariaLabel}>
        {value === "" ? <span className="font-normal text-slate-400">—</span> : value}
      </span>
    </span>
  );
}

function CountInput({
  field,
  label,
  icon,
  value,
  error,
  inputRef,
  onChange,
}: {
  field: CountKey;
  label: string;
  icon: React.ReactNode;
  value: string;
  error?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  onChange: (text: string) => void;
}) {
  const id = `store-count-${field}`;
  return (
    <div className="relative min-w-0 flex-1" title={error ?? `Committed ${label.toLowerCase()}`}>
      <Label htmlFor={id} className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-slate-500">
        {icon}
        <span className="sr-only">{label}</span>
      </Label>
      <Input
        ref={inputRef}
        id={id}
        inputMode="numeric"
        className="h-8 pl-7 tabular-nums"
        placeholder="—"
        value={value}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/** What the installed hardware cost Dolphin: a stick per screen, plus the screen for a Dolphin TV. The total, then
 *  the lines in small type; a price not set in Settings shows as a small hint (the full sentence on hover). */
function HardwareCard({ cost }: { cost: ReturnType<typeof hardwareCost> }) {
  const missing = cost.missing.length ? `Set the ${cost.missing.join(", ")} price in Settings` : "";
  return (
    <section aria-label="Hardware cost" className={CARD}>
      <CardTitle
        title="Hardware cost"
        tone="Hardware cost"
        right={
          cost.installed === 0 ? (
            <span className="text-lg leading-none text-slate-400">—</span>
          ) : cost.total === null ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-800" title={missing}>
              <AlertTriangle size={12} aria-hidden /> Price missing<span className="sr-only">: {missing}</span>
            </span>
          ) : (
            <span className="font-mono text-lg font-semibold leading-none tabular-nums text-slate-900">{money(cost.total)}</span>
          )
        }
      />
      {cost.installed > 0 && (
        <ul className="space-y-0.5 text-xs text-slate-600" aria-label="Hardware cost lines">
          {cost.lines.map((line) => (
            <li key={line.label} className="flex justify-between gap-2">
              <span className="min-w-0 truncate" title={`${line.count} × ${line.label}`}>
                {line.count} × {line.label}
              </span>
              <span className={cn("font-mono tabular-nums", line.price === null && "text-amber-800")}>{line.price === null ? "no price" : money(line.count * line.price)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Mounts needed and used, both worked out from the screens and the mount picked on each (nothing is typed), each
 *  split per piece. */
function MountsCard({ rows }: { rows: ScreenRow[] }) {
  const needed = computedMounts(rows);
  const used = computedMountsUsedByPiece(rows);
  const lines = [
    { label: "Mounts needed", short: "Needed", counts: needed, total: MOUNTS.reduce((total, mount) => total + needed[mount.kind], 0), hint: "Screens not installed yet (Upcoming, Not Registered) with a mount picked" },
    { label: "Mounts used", short: "Used", counts: used, total: computedMountsUsed(rows), hint: "Installed screens (Online, Offline, Needs More Work) with a mount picked" },
  ];
  const cell = "px-1 text-right tabular-nums";
  return (
    <section aria-label="Mounts" className={CARD}>
      <table className="w-full text-sm">
        <caption className="sr-only">Mounts per piece</caption>
        <thead>
          <tr className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
            <th scope="col" className="pb-1 text-left font-normal">
              <h3 className={cn("flex items-center gap-2 text-[11px] font-medium", SECTION_TONE.Mounts.title)}>
                <ToneChip name="Mounts" /> Mounts
              </h3>
            </th>
            <th scope="col" className="pb-1 text-right font-normal">
              <span className="sr-only">Total</span>
            </th>
            {MOUNTS.map((mount) => (
              <th key={mount.kind} scope="col" className="w-[3.25rem] pb-1 text-right font-normal normal-case tracking-normal">
                {mount.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.label} title={line.hint}>
              <th scope="row" className="py-1 text-left font-normal text-slate-600">
                {line.short}
              </th>
              <td className={cn(cell, "text-lg font-semibold leading-none text-slate-900")} aria-label={line.label}>
                {line.total}
              </td>
              {MOUNTS.map((mount) => (
                <td key={mount.kind} className={cn(cell, line.counts[mount.kind] ? "text-slate-900" : "text-slate-400")} aria-label={`${line.label}: ${mount.label}`}>
                  {line.counts[mount.kind]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Who installs at this store: a technician (the default; name typed or picked), the store itself, or a rep. Self
 *  and rep installs send no technician, so the name box gives way to a pill; the typed name stays in the draft, so
 *  switching back to Technician before saving brings it back. */
function AssignmentCard({
  technician,
  installType,
  technicians,
  onTechnician,
  onInstallType,
}: {
  technician: string;
  installType: string;
  technicians: string[];
  onTechnician: (name: string) => void;
  onInstallType: (type: string) => void;
}) {
  const type = NO_TECHNICIAN.has(installType) ? installType : "Technician";
  // The Installers page's names first in line, then any other name stores of this project already carry.
  const installers = useInstallers().data?.map((item) => item.value) ?? [];
  const listed = new Set(installers.map(nameKey));
  const options = [...installers, ...new Set(technicians.filter((name) => name && !listed.has(nameKey(name))))].sort((a, b) => a.localeCompare(b));
  const unknown = type === "Technician" && technician.trim() !== "" && installers.length > 0 && !listed.has(nameKey(technician));
  return (
    <section aria-label="Assignment" className={CARD}>
      <CardTitle title="Installed by" tone="Installed by" hint="Who is sent to install at this store" />
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Select value={type} onValueChange={onInstallType}>
          <SelectTrigger size="sm" aria-label="Install type" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INSTALL_CHOICES.map((choice) => (
              <SelectItem key={choice} value={choice}>
                {choice}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="min-w-32 flex-1">
          {type === "Technician" ? (
            <>
              <Label htmlFor="store-technician" className="sr-only">
                Technician
              </Label>
              <SuggestInput id="store-technician" className="h-8" placeholder="Assign a technician" value={technician} onValueChange={onTechnician} options={options} />
            </>
          ) : (
            <span
              className="inline-flex h-8 items-center rounded-full border border-brand/30 bg-brand/10 px-4 text-sm font-semibold text-brand"
              aria-label={`Technician: ${type.toLowerCase()}`}
              title={type === SELF_INSTALL ? "The store installs its own screens: no technician is sent" : "A rep installs: no technician is sent"}
            >
              {type === SELF_INSTALL ? "Self" : "Rep"}
            </span>
          )}
        </div>
      </div>
      {unknown && (
        <p className="flex items-center gap-1 text-xs text-amber-800" role="note">
          <NotAnInstaller name={technician.trim()} /> Not in the Installers list
        </p>
      )}
    </section>
  );
}
