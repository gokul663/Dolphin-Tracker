import { useEffect, useState } from "react";
import { Loader2, Monitor, Tv, Usb } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useUpdateProject } from "@/features/projects/api";
import { SectionTitle } from "@/features/settings/DetailsSection";
import type { HardwareCosts } from "@/features/stores/details";
import type { Project } from "@/lib/api/types";

const PRICES: { key: keyof HardwareCosts; label: string; icon: React.ReactNode }[] = [
  { key: "stick", label: "Stick", icon: <Usb size={14} /> },
  { key: "screen_24", label: '24" Dolphin TV', icon: <Monitor size={14} /> },
  { key: "screen_43", label: '43" Dolphin TV', icon: <Tv size={14} /> },
  { key: "screen_50", label: '50" Dolphin TV', icon: <Tv size={16} /> },
];

type Draft = Record<keyof HardwareCosts, string>;
const draftOf = (costs: HardwareCosts): Draft =>
  Object.fromEntries(PRICES.map(({ key }) => [key, costs[key] === null ? "" : String(costs[key])])) as Draft;
const valid = (text: string) => text.trim() === "" || /^\d+(\.\d{1,2})?$/.test(text.trim());

/** What the hardware costs Dolphin in this project: a stick for every installed screen, plus the screen for a
 *  Dolphin TV by size. The Stores table and the store window add these up per store. */
export function HardwareCostsSection({ project }: { project: Project }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(project.hardware_costs));
  useEffect(() => setDraft(draftOf(project.hardware_costs)), [project.hardware_costs]);
  const update = useUpdateProject(project.id);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(project.hardware_costs));
  const bad = PRICES.filter(({ key }) => !valid(draft[key]));
  const save = async () => {
    if (bad.length) return;
    const hardware_costs = Object.fromEntries(
      PRICES.map(({ key }) => [key, draft[key].trim() === "" ? null : Number(draft[key].trim())]),
    ) as HardwareCosts;
    try {
      await update.mutateAsync({ hardware_costs, expected_version: project.version });
      toast.success("Hardware prices saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Save failed");
    }
  };
  return (
    <Card className="gap-4 p-5" aria-label="Hardware costs">
      <SectionTitle
        title="Hardware costs"
        hint="What each piece costs us. A store's hardware cost counts its installed screens (Completed, Offline, Needs More Work): a stick for each, plus the screen for a Dolphin TV."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {PRICES.map(({ key, label, icon }) => (
          <div key={key} className="space-y-1.5">
            <Label htmlFor={`price-${key}`} className="flex items-center gap-1.5">
              {icon} {label}
            </Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">$</span>
              <Input
                id={`price-${key}`}
                inputMode="decimal"
                className="pl-7 tabular-nums"
                placeholder="not set"
                value={draft[key]}
                aria-invalid={!valid(draft[key])}
                onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
              />
            </div>
            {!valid(draft[key]) && <p className="text-xs text-rose-600">Enter an amount, e.g. 45 or 45.50</p>}
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={!dirty || update.isPending} onClick={() => setDraft(draftOf(project.hardware_costs))}>
          Discard
        </Button>
        <Button onClick={() => void save()} disabled={!dirty || bad.length > 0 || update.isPending}>
          {update.isPending && <Loader2 className="animate-spin" />} Save prices
        </Button>
      </div>
    </Card>
  );
}
