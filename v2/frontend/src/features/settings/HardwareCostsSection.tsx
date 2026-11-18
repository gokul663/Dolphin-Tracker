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

/** One screen model being edited: all text, so a half-typed amount is kept as typed. */
interface Row {
  key: string;
  size: string;
  type: string;
  cost: string;
}
interface Draft {
  stick: string;
  rows: Row[];
}

let nextKey = 0;
const amount = (value: number | null) => (value === null ? "" : String(value));
const draftOf = (costs: HardwareCosts): Draft => ({
  stick: amount(costs.stick),
  rows: costs.screens.map((row) => ({ key: `row-${(nextKey += 1)}`, size: row.size.replace('"', ""), type: row.type, cost: amount(row.cost) })),
});
/** What is compared and sent: no local keys, sizes as labels. */
const toCosts = (draft: Draft): HardwareCosts => ({
  stick: draft.stick.trim() === "" ? null : Number(draft.stick.trim()),
  screens: draft.rows.map((row) => ({ size: sizeLabel(row.size), type: row.type.trim().replace(/\s+/g, " "), cost: row.cost.trim() === "" ? null : Number(row.cost.trim()) })),
});
const validAmount = (text: string) => text.trim() === "" || /^\d+(\.\d{1,2})?$/.test(text.trim());

/** Problems by row key: a size is needed, the amount must read as money, a size + type is listed once. */
function rowErrors(rows: Row[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const id = `${sizeLabel(row.size)}|${row.type.trim().toLowerCase()}`;
    if (!sizeLabel(row.size)) errors[row.key] = "Enter the size in inches, e.g. 24";
    else if (!validAmount(row.cost)) errors[row.key] = "Enter an amount, e.g. 120 or 120.50";
    else if (seen.has(id)) errors[row.key] = "This size and type is already listed";
    seen.add(id);
  }
  return errors;
}

/** What the hardware costs Dolphin in this project: a stick for every installed screen, plus the screen itself for a
 *  Dolphin-owned one, by size and type. The types listed for a size are what the store window offers when that size
 *  is picked for a Dolphin screen. */
export function HardwareCostsSection({ project }: { project: Project }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(project.hardware_costs));
  useEffect(() => setDraft(draftOf(project.hardware_costs)), [project.hardware_costs]);
  const update = useUpdateProject(project.id);
  const errors = rowErrors(draft.rows);
  const stickBad = !validAmount(draft.stick);
  const bad = stickBad || Object.keys(errors).length > 0;
  const dirty = bad || JSON.stringify(toCosts(draft)) !== JSON.stringify(toCosts(draftOf(project.hardware_costs)));
  const patch = (key: string, change: Partial<Row>) => setDraft((current) => ({ ...current, rows: current.rows.map((row) => (row.key === key ? { ...row, ...change } : row)) }));
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
      <div className="space-y-2">
        <div>
          <h3 className="text-sm font-medium text-slate-900">Dolphin screens</h3>
          <p className="text-xs text-slate-500">
            The screens we own, by size and type. Two types of one size (say our own 24″ and a Dell 24″) each get a row; the store window asks which one when
            that size is picked.
          </p>
        </div>
        {draft.rows.length > 0 && (
          <div className="grid grid-cols-[5.5rem_minmax(0,1fr)_8rem_2rem] items-center gap-x-2 font-mono text-[11px] uppercase tracking-wider text-slate-500" aria-hidden>
            <span>Size (in)</span>
            <span>Type</span>
            <span>Cost</span>
            <span />
          </div>
        )}
        <ul className="space-y-2" aria-label="Dolphin screen prices">
          {draft.rows.map((row, index) => (
            <li key={row.key} className="space-y-1">
              <div className="grid grid-cols-[5.5rem_minmax(0,1fr)_8rem_2rem] items-center gap-x-2">
                <Input
                  inputMode="numeric"
                  className="tabular-nums"
                  placeholder="24"
                  aria-label={`Size, screen price ${index + 1}`}
                  value={row.size}
                  aria-invalid={Boolean(errors[row.key]) && !sizeLabel(row.size)}
                  onChange={(event) => patch(row.key, { size: event.target.value })}
                />
                <Input placeholder="e.g. Dolphin, Dell" aria-label={`Type, screen price ${index + 1}`} value={row.type} onChange={(event) => patch(row.key, { type: event.target.value })} />
                <MoneyInput ariaLabel={`Cost, screen price ${index + 1}`} value={row.cost} invalid={!validAmount(row.cost)} onChange={(cost) => patch(row.key, { cost })} />
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  aria-label={`Remove screen price ${index + 1}`}
                  onClick={() => setDraft((current) => ({ ...current, rows: current.rows.filter((item) => item.key !== row.key) }))}
                >
                  <Trash2 />
                </Button>
              </div>
              {errors[row.key] && <p className="text-xs text-rose-600">{errors[row.key]}</p>}
            </li>
          ))}
        </ul>
        {draft.rows.length === 0 && <p className="text-sm text-slate-500">No screens priced yet.</p>}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setDraft((current) => ({ ...current, rows: [...current.rows, { key: `row-${(nextKey += 1)}`, size: "", type: "", cost: "" }] }))}
        >
          <Plus /> Add a screen
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

function MoneyInput({ id, ariaLabel, value, invalid, onChange }: { id?: string; ariaLabel?: string; value: string; invalid: boolean; onChange: (value: string) => void }) {
  return (
    <div className="relative">
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">$</span>
      <Input id={id} aria-label={ariaLabel} inputMode="decimal" className="pl-7 tabular-nums" placeholder="not set" value={value} aria-invalid={invalid} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}
