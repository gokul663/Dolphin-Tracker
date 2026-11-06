import { Minus, Plus, Trash2 } from "lucide-react";
import { NameField } from "@/components/NameField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StartLocationField } from "@/features/planner/StartLocationField";
import type { StartLocation } from "@/lib/api/types";

export interface InstallerDraft {
  name: string;
  start: StartLocation | null;
}

export const emptyInstaller = (): InstallerDraft => ({ name: "", start: null });

/** Problems that block saving: blank or repeated names, missing starts. */
export function installerProblems(rows: InstallerDraft[]): string[] {
  const problems: string[] = [];
  if (!rows.length) problems.push("Add at least one installer.");
  const names = rows.map((row) => row.name.trim().toLowerCase());
  if (names.some((name) => !name)) problems.push("Every installer needs a name.");
  if (new Set(names.filter(Boolean)).size !== names.filter(Boolean).length) problems.push("Installer names must be different.");
  if (rows.some((row) => !row.start)) problems.push("Every installer needs a starting location (press Find).");
  return problems;
}

/** "How many installers" plus one row per installer: a name from the list (or a new one) and a start location. */
export function InstallerRows({ rows, onChange }: { rows: InstallerDraft[]; onChange: (rows: InstallerDraft[]) => void }) {
  const setCount = (count: number) => {
    const n = Math.max(1, Math.min(50, count || 1));
    onChange(n > rows.length ? [...rows, ...Array.from({ length: n - rows.length }, emptyInstaller)] : rows.slice(0, n));
  };
  const patch = (index: number, change: Partial<InstallerDraft>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...change } : row)));
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Label htmlFor="installer-count">Number of installers</Label>
        <Button size="icon-sm" variant="outline" aria-label="One fewer installer" onClick={() => setCount(rows.length - 1)} disabled={rows.length <= 1}>
          <Minus />
        </Button>
        <Input
          id="installer-count"
          type="number"
          min={1}
          max={50}
          className="h-8 w-16 text-center"
          value={rows.length}
          onChange={(event) => setCount(Number(event.target.value))}
        />
        <Button size="icon-sm" variant="outline" aria-label="One more installer" onClick={() => setCount(rows.length + 1)}>
          <Plus />
        </Button>
      </div>
      <ol className="space-y-3">
        {rows.map((row, index) => (
          <li key={index} className="grid gap-2 rounded-xl border bg-white p-3 md:grid-cols-[220px_minmax(0,1fr)_auto] md:items-start">
            <NameField kind="installers" aria-label={`Installer ${index + 1} name`} placeholder={`Installer ${index + 1}`} value={row.name} onChange={(name) => patch(index, { name })} />
            <StartLocationField label={`Starting location for installer ${index + 1}`} value={row.start} onChange={(start) => patch(index, { start })} />
            <Button size="icon" variant="ghost" aria-label={`Remove installer ${index + 1}`} disabled={rows.length <= 1} onClick={() => onChange(rows.filter((_, i) => i !== index))}>
              <Trash2 />
            </Button>
          </li>
        ))}
      </ol>
    </div>
  );
}
