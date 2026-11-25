import { Check, HardHat, Monitor, Tv, Wrench } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { SuggestInput } from "@/components/SuggestInput";
import { Label } from "@/components/ui/label";
import { actualCounts, fulfillment, hardwareCost, money, sizeLabel, type HardwareCosts } from "@/features/stores/details";
import { bucketOf } from "@/lib/status";
import { nameKey, NotAnInstaller } from "@/features/installers/InstallerName";
import { useInstallers } from "@/features/lists/api";
import type { ScreenRow } from "@/features/stores/ScreensEditor";
import { cn } from "@/lib/utils";

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

/** Mounts worked out from the screens still to be installed (Upcoming) and the mount picked on each (backend
 *  `mounts_needed`). */
export function computedMounts(rows: Pick<ScreenRow, "status" | "has_mount" | "has_ceiling_mount" | "screen_size">[]): Record<MountKind, number> {
  const counts = { wall_24: 0, wall: 0, ceiling: 0 };
  for (const row of rows) {
    if (!row.has_mount || bucketOf(row.status) !== "Upcoming") continue;
    counts[row.has_ceiling_mount ? "ceiling" : (sizeLabel(row.screen_size) || '24"') === '24"' ? "wall_24" : "wall"] += 1;
  }
  return counts;
}

const toNumber = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);

/** The top of the store window: what was committed and what is installed (screens and TVs apart), the mounts to
 *  bring, and who is assigned to install. Everything is a draft until the window's Save. */
export function StoreSummary({
  draft,
  costs,
  technicians,
  onCount,
  onTechnician,
  onInstallType,
}: {
  draft: SummaryDraft;
  /** The project's hardware prices (Settings). */
  costs: HardwareCosts;
  technicians: string[];
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
  const worked = computedMounts(draft.rows);
  const count = (key: CountKey, label: string, icon?: React.ReactNode) => (
    <CountInput field={key} label={label} icon={icon} value={counts[key]} error={draft.errors[key]} onChange={(text) => onCount(key, text)} />
  );
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.3fr)]" aria-label="Store summary">
      <section aria-label="Committed" className="flex flex-col gap-2 rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5">
        <CardTitle title="Committed" right={<Total value={sum(toNumber(counts.committed_dolphin_screens), toNumber(counts.committed_store_tvs))} label="Committed total" />} />
        <div className="grid grid-cols-2 gap-2">
          {count("committed_dolphin_screens", "Screens", <Monitor size={13} />)}
          {count("committed_store_tvs", "TVs", <Tv size={13} />)}
        </div>
        <p className="text-xs text-slate-500">
          Screen rows: {rows.dolphin} screens · {rows.tvs} TVs
        </p>
      </section>
      <InstalledCard
        screens={done.installedScreens}
        tvs={done.installedTvs}
        installed={done.installed}
        committed={done.committed}
        fulfilled={done.fulfilled}
        cost={costs.hidden ? null : hardwareCost(draft.rows, costs)}
      />
      <section aria-label="Mounts needed" className="flex flex-col gap-2 rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5">
        <CardTitle
          title="Mounts needed"
          icon={<Wrench size={13} />}
          right={<Total value={MOUNTS.reduce((total, mount) => total + (toNumber(counts[mount.field]) ?? worked[mount.kind]), 0)} label="Mounts total" />}
        />
        {/* Per piece: the number worked out from the Upcoming screens' mounts, and a box to type another over it. */}
        <div className="grid grid-cols-3 gap-2">
          {MOUNTS.map((mount) => (
            <div key={mount.kind} className="space-y-1">
              <p className="text-[11px] text-slate-500">{mount.label}</p>
              <p className="flex items-baseline gap-1" title="Worked out from the Upcoming screens and the mount picked on each">
                <span
                  className={cn("text-lg font-semibold leading-none tabular-nums", toNumber(counts[mount.field]) === null ? "text-slate-800" : "text-slate-400 line-through")}
                  aria-label={`${mount.label} computed`}
                >
                  {worked[mount.kind]}
                </span>
                <span className="text-[10px] uppercase tracking-wider text-slate-400">computed</span>
              </p>
              <CountInput
                field={mount.field}
                label="Override"
                ariaLabel={`${mount.label} override`}
                value={counts[mount.field]}
                error={draft.errors[mount.field]}
                onChange={(text) => onCount(mount.field, text)}
              />
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-500">To bring and fit at this store. Leave Override empty to use the computed number.</p>
      </section>
      <AssignmentCard technician={draft.technician} installType={draft.installType} technicians={technicians} onTechnician={onTechnician} onInstallType={onInstallType} />
    </div>
  );
}

const sum = (...values: (number | null)[]) =>
  values.every((value) => value === null) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0);

function CardTitle({ title, icon, right }: { title: string; icon?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-slate-500">
        {icon}
        {title}
      </h3>
      {right}
    </div>
  );
}

function Total({ value, label, tone }: { value: number | null; label: string; tone?: string }) {
  return (
    <span className={cn("text-2xl font-semibold leading-none tabular-nums", tone ?? "text-slate-800")} aria-label={label}>
      {value === null ? "—" : value}
    </span>
  );
}

function CountInput({
  field,
  label,
  ariaLabel,
  icon,
  value,
  error,
  onChange,
}: {
  field: CountKey;
  label: string;
  ariaLabel?: string;
  icon?: React.ReactNode;
  value: string;
  error?: string;
  onChange: (text: string) => void;
}) {
  const id = `store-count-${field}`;
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="flex items-center gap-1 text-[11px] font-normal text-slate-500">
        {icon}
        {label}
      </Label>
      <Input
        id={id}
        aria-label={ariaLabel}
        inputMode="numeric"
        className="h-8 tabular-nums"
        placeholder="—"
        value={value}
        aria-invalid={Boolean(error)}
        title={error}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function InstalledCard({
  screens,
  tvs,
  installed,
  committed,
  fulfilled,
  cost,
}: {
  screens: number;
  tvs: number;
  installed: number;
  committed: number;
  fulfilled: boolean;
  /** Null: the project hides its hardware cost (Settings). */
  cost: ReturnType<typeof hardwareCost> | null;
}) {
  return (
    <section aria-label="Installed" className={cn("flex flex-col gap-2 rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5", fulfilled && "bg-green-50 ring-green-300")}>
      <CardTitle
        title="Installed"
        right={
          <span className="flex items-center gap-1.5">
            {fulfilled && <Check size={15} className="text-green-700" aria-label="Fulfilled" />}
            <Total value={installed} label="Installed total" tone={fulfilled ? "text-green-700" : undefined} />
          </span>
        }
      />
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt className="flex items-center gap-1 text-[11px] text-slate-500">
            <Monitor size={13} /> Screens
          </dt>
          <dd className="h-8 py-1 text-lg font-medium tabular-nums" aria-label="Installed screens">
            {screens}
          </dd>
        </div>
        <div>
          <dt className="flex items-center gap-1 text-[11px] text-slate-500">
            <Tv size={13} /> TVs
          </dt>
          <dd className="h-8 py-1 text-lg font-medium tabular-nums" aria-label="Installed TVs">
            {tvs}
          </dd>
        </div>
      </dl>
      {committed > 0 ? (
        <>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden>
            <div className={cn("h-full rounded-full", fulfilled ? "bg-green-600" : "bg-brand")} style={{ width: `${Math.round(Math.min(1, installed / committed) * 100)}%` }} />
          </div>
          <p className="text-xs text-slate-500">
            {installed} of {committed} committed{fulfilled ? " · fulfilled" : ""}
          </p>
        </>
      ) : (
        <p className="text-xs text-slate-500">Completed, Offline or Needs More Work (no commitment yet)</p>
      )}
      {cost && (
        <>
          {/* What the installed hardware cost Dolphin: a stick per screen, plus the screen for a Dolphin TV. */}
          <div className="flex items-baseline justify-between gap-2 border-t pt-2 text-sm" aria-label="Hardware cost">
            <span className="text-slate-500">Hardware cost</span>
            {cost.installed === 0 ? (
              <span className="text-slate-300">—</span>
            ) : cost.total === null ? (
              <span className="text-xs text-amber-700">Set the {cost.missing.join(", ")} price in Settings</span>
            ) : (
              <span className="font-mono font-semibold tabular-nums text-slate-800">{money(cost.total)}</span>
            )}
          </div>
          {cost.installed > 0 && (
            <ul className="space-y-0.5 text-xs text-slate-500" aria-label="Hardware cost lines">
              {cost.lines.map((line) => (
                <li key={line.label} className="flex justify-between gap-2">
                  <span>
                    {line.count} × {line.label}
                  </span>
                  <span className="font-mono tabular-nums">{line.price === null ? "no price" : money(line.count * line.price)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
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
    <section aria-label="Assignment" className="flex flex-col gap-2 rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5">
      <h3 className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-slate-500">
        <HardHat size={13} /> Installed by
      </h3>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={type} onValueChange={onInstallType}>
          <SelectTrigger aria-label="Install type" className="w-36">
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
        <div className="min-w-0 flex-1">
          {type === "Technician" ? (
            <>
              <Label htmlFor="store-technician" className="sr-only">
                Technician
              </Label>
              <SuggestInput id="store-technician" placeholder="Assign a technician" value={technician} onValueChange={onTechnician} options={options} />
              {unknown && (
                <p className="mt-1 flex items-center gap-1 text-xs text-amber-700" role="note">
                  <NotAnInstaller name={technician.trim()} /> Not in the Installers list
                </p>
              )}
            </>
          ) : (
            <span
              className="inline-flex h-9 items-center rounded-full border border-brand/30 bg-brand/10 px-4 text-sm font-semibold text-brand"
              aria-label={`Technician: ${type.toLowerCase()}`}
            >
              {type === SELF_INSTALL ? "Self" : "Rep"}
            </span>
          )}
        </div>
      </div>
      <p className="text-xs text-slate-500">
        {type === SELF_INSTALL
          ? "The store installs its own screens: no technician is sent."
          : type === REP_INSTALL
            ? "A rep installs: no technician is sent."
            : "Who is sent to install at this store."}
      </p>
    </section>
  );
}
