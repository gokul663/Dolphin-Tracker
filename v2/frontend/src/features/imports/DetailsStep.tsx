import type { UseFormReturn } from "react-hook-form";
import { Label } from "@/components/ui/label";
import { SuggestInput } from "@/components/SuggestInput";
import { useDevicePas } from "@/features/device/api";
import { ProjectMetaFields } from "@/features/projects/ProjectMetaFields";
import type { WizardDetails } from "@/features/imports/wizardSchema";
import { cn } from "@/lib/utils";

/** Where a new project's stores come from: a sheet, or the PA's records in the Dolphin device data. */
export type StoreSource = "sheet" | "dolphin";

const SOURCES: { value: StoreSource; label: string; hint: string }[] = [
  { value: "sheet", label: "Upload a sheet", hint: "Import the store list from an Excel or CSV file." },
  {
    value: "dolphin",
    label: "CMS data only",
    hint: "No sheet: every venue of the PA in the device report becomes a store, at the report's address, and stays in sync.",
  },
];

/** Step 1 (new projects): metadata, and where the stores come from. Installers and stops per day are set per route
 *  plan in the Route Planner. */
export function DetailsStep({
  form,
  source,
  onSourceChange,
  devicePa,
  onDevicePaChange,
}: {
  form: UseFormReturn<WizardDetails>;
  source: StoreSource;
  onSourceChange: (source: StoreSource) => void;
  devicePa: string;
  onDevicePaChange: (pa: string) => void;
}) {
  const pas = useDevicePas(source === "dolphin");
  const known = pas.data?.pas ?? [];
  const unknownPa = devicePa.trim() !== "" && pas.isSuccess && !known.includes(devicePa.trim());
  return (
    <div className="space-y-5">
      <ProjectMetaFields form={form} />
      <fieldset className="space-y-3 rounded-lg border p-3">
        <legend className="px-1 font-mono text-[11px] uppercase tracking-wider text-slate-600">Stores from</legend>
        <div role="radiogroup" aria-label="Stores from" className="grid gap-2 sm:grid-cols-2">
          {SOURCES.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={source === option.value}
              onClick={() => onSourceChange(option.value)}
              className={cn(
                "rounded-md border p-3 text-left text-sm transition-colors",
                source === option.value ? "border-brand bg-brand/5 ring-1 ring-brand" : "hover:bg-slate-50",
              )}
            >
              <span className="font-medium">{option.label}</span>
              <span className="block text-xs text-slate-500">{option.hint}</span>
            </button>
          ))}
        </div>
        {source === "dolphin" && (
          <div className="space-y-1.5">
            <Label htmlFor="wizard-device-pa" className="font-mono text-[11px] uppercase tracking-wider text-slate-600">
              PA in the CMS data *
            </Label>
            <SuggestInput
              id="wizard-device-pa"
              placeholder={pas.isPending ? "Loading PA names…" : "Pick the PA name as the CMS writes it"}
              value={devicePa}
              onValueChange={onDevicePaChange}
              options={known}
            />
            {pas.isError && <p className="text-xs text-rose-700">Could not load the PA list: {pas.error.message}</p>}
            {unknownPa && (
              <p className="text-xs text-amber-700">Not a PA name in the report's latest day; no stores would be added.</p>
            )}
          </div>
        )}
      </fieldset>
      <p className="text-xs text-slate-500">Installers and stops per day are chosen when you build a route plan in the Route Planner.</p>
    </div>
  );
}
