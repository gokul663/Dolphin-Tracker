import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2, Usb } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useUpdateProject } from "@/features/projects/api";
import { SectionTitle } from "@/features/settings/DetailsSection";
import { sizeLabel, type HardwareCosts } from "@/features/stores/details";
import type { Project } from "@/lib/api/types";

/** One type of a size being edited (our own, a Dell...). */
interface TypeRow {
  key: string;
  type: string;
  isDefault: boolean;
}
/** One size, what a screen of it costs, and the types we own in it. The cost is text, so a half-typed amount is
 *  kept as typed. */
interface SizeGroup {
  key: string;
  size: string;
  cost: string;
  types: TypeRow[];
}
/** The mounts for one screen size: a wall mount and a ceiling mount, each with its cost (empty = none). */
interface MountRow {
  key: string;
  size: string;
  wall: string;
  ceiling: string;
}
interface Draft {
  stick: string;
  sizes: SizeGroup[];
  mounts: MountRow[];
}

let nextKey = 0;
const newKey = () => `k${(nextKey += 1)}`;
const amount = (value: number | null) => (value === null ? "" : String(value));
const inches = (size: string) => Number(size.replace(/\D/g, "")) || 0;
const named = (types: TypeRow[]) => types.filter((row) => row.type.trim() !== "");

/** The flat price list as size groups, smallest size first; each keeps its types in the saved order. A size's cost
 *  is one for all its types (the server holds to it). */
function draftOf(costs: HardwareCosts): Draft {
  const sizes: SizeGroup[] = [];
  for (const row of costs.screens) {
    const size = row.size.replace('"', "");
    let group = sizes.find((item) => item.size === size);
    if (!group) sizes.push((group = { key: newKey(), size, cost: amount(row.cost), types: [] }));
    if (group.cost === "") group.cost = amount(row.cost);
    if (row.type.trim()) group.types.push({ key: newKey(), type: row.type, isDefault: Boolean(row.is_default) });
  }
  for (const group of sizes) if (!group.types.some((row) => row.isDefault) && group.types[0]) group.types[0].isDefault = true;
  const mounts = (costs.mounts ?? [])
    .map((row) => ({ key: newKey(), size: row.size.replace('"', ""), wall: amount(row.wall), ceiling: amount(row.ceiling) }))
    .sort((a, b) => inches(a.size) - inches(b.size));
  return { stick: amount(costs.stick), sizes: sizes.sort((a, b) => inches(a.size) - inches(b.size)), mounts };
}

/** What is compared and sent: one row per named type, each with its size's cost; a size without types is one row
 *  with no type. */
const toCosts = (draft: Draft): HardwareCosts => ({
  stick: draft.stick.trim() === "" ? null : Number(draft.stick.trim()),
  screens: draft.sizes.flatMap((group) => {
    const size = sizeLabel(group.size);
    const cost = group.cost.trim() === "" ? null : Number(group.cost.trim());
    const types = named(group.types);
    if (types.length === 0) return [{ size, type: "", cost, is_default: true }];
    const chosen = types.find((row) => row.isDefault) ?? types[0]!;
    return types.map((row) => ({ size, type: row.type.trim().replace(/\s+/g, " "), cost, is_default: row === chosen }));
  }),
  mounts: draft.mounts.map((row) => ({ size: sizeLabel(row.size), wall: toAmount(row.wall), ceiling: toAmount(row.ceiling) })),
});
const toAmount = (text: string) => (text.trim() === "" ? null : Number(text.trim()));

/** Problems by mount row key: a size is needed and listed once, and both costs must read as money. */
function mountErrors(mounts: MountRow[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of mounts) {
    const label = sizeLabel(row.size);
    if (!label) errors[row.key] = "Enter the size in inches, e.g. 24";
    else if (seen.has(label)) errors[row.key] = `${label} is already listed`;
    else if (!validAmount(row.wall) || !validAmount(row.ceiling)) errors[row.key] = "Enter an amount, e.g. 15 or 15.50";
    seen.add(label);
  }
  return errors;
}
const validAmount = (text: string) => text.trim() === "" || /^\d+(\.\d{1,2})?$/.test(text.trim());

/** Problems by size or type key: a size is needed and listed once, its cost must read as money; within it a type is
 *  listed once. */
function draftErrors(sizes: SizeGroup[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const seenSizes = new Set<string>();
  for (const group of sizes) {
    const label = sizeLabel(group.size);
    if (!label) errors[group.key] = "Enter the size in inches, e.g. 24";
    else if (seenSizes.has(label)) errors[group.key] = `${label} is already listed: add its types there`;
    else if (!validAmount(group.cost)) errors[group.key] = "Enter an amount, e.g. 120 or 120.50";
    seenSizes.add(label);
    const seenTypes = new Set<string>();
    for (const row of named(group.types)) {
      const id = row.type.trim().toLowerCase();
      if (seenTypes.has(id)) errors[row.key] = "This type is already listed for this size";
      seenTypes.add(id);
    }
  }
  return errors;
}

const newType = (isDefault: boolean): TypeRow => ({ key: newKey(), type: "", isDefault });

/** What the hardware costs Dolphin in this project: a stick for every installed screen, plus the screen itself for a
 *  Dolphin-owned one. The screens are kept by size: a size has one cost, and the types we own in it (our own, a
 *  Dell...) are what the store window offers when that size is picked, the default one chosen to start with. */
export function HardwareCostsSection({ project }: { project: Project }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(project.hardware_costs));
  useEffect(() => setDraft(draftOf(project.hardware_costs)), [project.hardware_costs]);
  const update = useUpdateProject(project.id);
  const errors = { ...draftErrors(draft.sizes), ...mountErrors(draft.mounts) };
  const setMounts = (next: (mounts: MountRow[]) => MountRow[]) => setDraft((current) => ({ ...current, mounts: next(current.mounts) }));
  const patchMount = (key: string, change: Partial<MountRow>) => setMounts((mounts) => mounts.map((row) => (row.key === key ? { ...row, ...change } : row)));
  const stickBad = !validAmount(draft.stick);
  const bad = stickBad || Object.keys(errors).length > 0;
  const dirty = bad || JSON.stringify(toCosts(draft)) !== JSON.stringify(toCosts(draftOf(project.hardware_costs)));
  const setSizes = (next: (sizes: SizeGroup[]) => SizeGroup[]) => setDraft((current) => ({ ...current, sizes: next(current.sizes) }));
  const patchSize = (key: string, change: (group: SizeGroup) => SizeGroup) => setSizes((sizes) => sizes.map((group) => (group.key === key ? change(group) : group)));
  const patchType = (sizeKey: string, key: string, change: Partial<TypeRow>) =>
    patchSize(sizeKey, (group) => ({ ...group, types: group.types.map((row) => (row.key === key ? { ...row, ...change } : row)) }));
  const removeType = (sizeKey: string, key: string) =>
    patchSize(sizeKey, (group) => {
      const types = group.types.filter((row) => row.key !== key);
      // The default went with it: the first one left takes over.
      return { ...group, types: types.some((row) => row.isDefault) ? types : types.map((row, index) => ({ ...row, isDefault: index === 0 })) };
    });
  const save = async () => {
    if (bad) return;
    try {
      await update.mutateAsync({ hardware_costs: toCosts(draft), expected_version: project.version });
      toast.success("Hardware prices saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Save failed");
    }
  };
  return (
    <Card className="gap-4 p-5" aria-label="Hardware costs">
      <SectionTitle
        title="Hardware costs"
        hint="What each piece costs us. A store's hardware cost counts its installed screens (Completed, Offline, Needs More Work): a stick for each, plus the screen for a Dolphin-owned one."
      />
      <div className="max-w-56 space-y-1.5">
        <Label htmlFor="price-stick" className="flex items-center gap-1.5">
          <Usb size={14} /> Stick
        </Label>
        <MoneyInput id="price-stick" value={draft.stick} invalid={stickBad} onChange={(stick) => setDraft((current) => ({ ...current, stick }))} />
        {stickBad && <p className="text-xs text-rose-600">Enter an amount, e.g. 45 or 45.50</p>}
      </div>
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-slate-900">Dolphin screens</h3>
          <p className="text-xs text-slate-500">
            The screens we own: add a size and what a screen of that size costs, then the types we have in it (say our own 24″ and a Dell 24″). The store
            window asks which type when that size is picked, starting on the default.
          </p>
        </div>
        {draft.sizes.length === 0 && <p className="text-sm text-slate-500">No screens priced yet.</p>}
        <ul className="space-y-3" aria-label="Dolphin screen prices">
          {draft.sizes.map((group) => {
            const name = sizeLabel(group.size) || "new size";
            return (
              <li key={group.key} className="rounded-xl bg-slate-50 p-3" aria-label={`Screens of ${name}`}>
                <div className="flex items-center gap-2">
                  <Label htmlFor={`size-${group.key}`} className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
                    Size
                  </Label>
                  <div className="relative w-24">
                    <Input
                      id={`size-${group.key}`}
                      inputMode="numeric"
                      className="bg-white pr-8 font-semibold tabular-nums"
                      placeholder="24"
                      value={group.size}
                      aria-invalid={Boolean(errors[group.key])}
                      onChange={(event) => patchSize(group.key, (current) => ({ ...current, size: event.target.value }))}
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">in</span>
                  </div>
                  <Label htmlFor={`cost-${group.key}`} className="ml-3 font-mono text-[11px] uppercase tracking-wider text-slate-500">
                    Cost
                  </Label>
                  <div className="w-32">
                    <MoneyInput
                      id={`cost-${group.key}`}
                      ariaLabel={`Cost of ${name}`}
                      value={group.cost}
                      invalid={!validAmount(group.cost)}
                      onChange={(cost) => patchSize(group.key, (current) => ({ ...current, cost }))}
                    />
                  </div>
                  <Button size="sm" variant="ghost" className="ml-auto text-slate-500" onClick={() => setSizes((sizes) => sizes.filter((item) => item.key !== group.key))}>
                    <Trash2 /> Remove {name}
                  </Button>
                </div>
                {errors[group.key] && <p className="mt-1 text-xs text-rose-600">{errors[group.key]}</p>}
                {group.types.length > 0 && (
                  <div className="mt-3 grid grid-cols-[4.5rem_minmax(0,1fr)_2rem] items-center gap-x-2 font-mono text-[11px] uppercase tracking-wider text-slate-500" aria-hidden>
                    <span>Default</span>
                    <span>Type</span>
                    <span />
                  </div>
                )}
                <ul className="mt-1 space-y-1.5" role="radiogroup" aria-label={`Default type of ${name}`}>
                  {group.types.map((row, index) => (
                    <li key={row.key} className="space-y-1">
                      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_2rem] items-center gap-x-2">
                        <span className="flex justify-center">
                          <input
                            type="radio"
                            name={`default-${group.key}`}
                            className="size-4 accent-brand"
                            aria-label={`${row.type.trim() || `Type ${index + 1}`} is the default of ${name}`}
                            checked={row.isDefault}
                            onChange={() => patchSize(group.key, (current) => ({ ...current, types: current.types.map((item) => ({ ...item, isDefault: item.key === row.key })) }))}
                          />
                        </span>
                        <Input
                          className="bg-white"
                          placeholder="e.g. Dolphin, Dell"
                          aria-label={`Type ${index + 1} of ${name}`}
                          value={row.type}
                          onChange={(event) => patchType(group.key, row.key, { type: event.target.value })}
                        />
                        <Button size="icon" variant="ghost" className="size-8" aria-label={`Remove type ${index + 1} of ${name}`} onClick={() => removeType(group.key, row.key)}>
                          <Trash2 />
                        </Button>
                      </div>
                      {errors[row.key] && <p className="pl-[5rem] text-xs text-rose-600">{errors[row.key]}</p>}
                    </li>
                  ))}
                </ul>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2 text-brand"
                  aria-label={`Add a type to ${name}`}
                  onClick={() => patchSize(group.key, (current) => ({ ...current, types: [...current.types, newType(current.types.length === 0)] }))}
                >
                  <Plus /> Add type
                </Button>
              </li>
            );
          })}
        </ul>
        <Button size="sm" variant="outline" onClick={() => setSizes((sizes) => [...sizes, { key: newKey(), size: "", cost: "", types: [] }])}>
          <Plus /> Add size
        </Button>
      </div>
      {/* Mounts: a size first, then what its wall mount and (if we have one) its ceiling mount cost. */}
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-slate-900">Mounts</h3>
          <p className="text-xs text-slate-500">
            Add a screen size, then what its wall mount costs and, if there is one, its ceiling mount. Leave a cost empty when that size has no such mount. The
            hardware cost counts mounts only when "Include mount costs" is ticked on the Stores page.
          </p>
        </div>
        {draft.mounts.length === 0 && <p className="text-sm text-slate-500">No mounts priced yet.</p>}
        <ul className="space-y-2" aria-label="Mount prices">
          {draft.mounts.map((row) => {
            const name = sizeLabel(row.size) || "new size";
            return (
              <li key={row.key} className="rounded-xl bg-slate-50 p-3" aria-label={`Mounts of ${name}`}>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="space-y-1">
                    <Label htmlFor={`mount-size-${row.key}`} className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
                      Size
                    </Label>
                    <div className="relative w-24">
                      <Input
                        id={`mount-size-${row.key}`}
                        aria-label={`Mount size ${name}`}
                        inputMode="numeric"
                        className="bg-white pr-8 font-semibold tabular-nums"
                        placeholder="24"
                        value={row.size}
                        aria-invalid={Boolean(errors[row.key])}
                        onChange={(event) => patchMount(row.key, { size: event.target.value })}
                      />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">in</span>
                    </div>
                  </div>
                  {(
                    [
                      ["wall", "Wall mount"],
                      ["ceiling", "Ceiling mount"],
                    ] as const
                  ).map(([kind, label]) => (
                    <div key={kind} className="w-36 space-y-1">
                      <Label htmlFor={`mount-${kind}-${row.key}`} className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
                        {label}
                      </Label>
                      <MoneyInput
                        id={`mount-${kind}-${row.key}`}
                        ariaLabel={`${label} of ${name}`}
                        placeholder="none"
                        value={row[kind]}
                        invalid={!validAmount(row[kind])}
                        onChange={(value) => patchMount(row.key, { [kind]: value })}
                      />
                    </div>
                  ))}
                  <Button size="sm" variant="ghost" className="ml-auto text-slate-500" onClick={() => setMounts((mounts) => mounts.filter((item) => item.key !== row.key))}>
                    <Trash2 /> Remove {name}
                  </Button>
                </div>
                {errors[row.key] && <p className="mt-1 text-xs text-rose-600">{errors[row.key]}</p>}
              </li>
            );
          })}
        </ul>
        <Button size="sm" variant="outline" aria-label="Add a mount size" onClick={() => setMounts((mounts) => [...mounts, { key: newKey(), size: "", wall: "", ceiling: "" }])}>
          <Plus /> Add mount size
        </Button>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={!dirty || update.isPending} onClick={() => setDraft(draftOf(project.hardware_costs))}>
          Discard
        </Button>
        <Button onClick={() => void save()} disabled={!dirty || bad || update.isPending}>
          {update.isPending && <Loader2 className="animate-spin" />} Save prices
        </Button>
      </div>
    </Card>
  );
}

function MoneyInput({ id, ariaLabel, value, invalid, onChange, placeholder = "not set" }: { id?: string; ariaLabel?: string; value: string; invalid: boolean; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <div className="relative">
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">$</span>
      <Input id={id} aria-label={ariaLabel} inputMode="decimal" className="bg-white pl-7 tabular-nums" placeholder={placeholder} value={value} aria-invalid={invalid} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}
