import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseMaxHours } from "@/features/planner/planModel";

/** Longest driving day per installer, in hours; blank means no limit. Drive time only, no return trip. */
export function MaxHoursField({
  id,
  value,
  onChange,
  label = "Max driving per day (hours)",
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  const invalid = parseMaxHours(value) === null;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" min={0} max={24} step={0.5} placeholder="No limit" value={value} onChange={(e) => onChange(e.target.value)} />
      {invalid ? (
        <p className="text-xs text-rose-700">Between 0 and 24 hours, or blank for no limit.</p>
      ) : (
        <p className="text-xs text-slate-500">Google driving time from the day's start to the last store; a longer day is split.</p>
      )}
    </div>
  );
}
