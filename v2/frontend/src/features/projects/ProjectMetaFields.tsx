import type { FieldPath, PathValue, UseFormReturn } from "react-hook-form";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ProjectMetaForm } from "@/features/projects/schema";
import { PROJECT_TYPE_LABELS } from "@/lib/status";

type FieldName = keyof ProjectMetaForm;

/** Metadata inputs shared by the edit dialog, the import wizard and the Settings tab. Works with any form whose
 * values include the metadata fields. The PA and the field agent each sit behind a
 * checkbox: a sheet may list several PAs, and many projects have no field agent. */
export function ProjectMetaFields<T extends ProjectMetaForm>({ form }: { form: UseFormReturn<T> }) {
  const { register, formState, watch, setValue } = form;
  const path = (name: FieldName) => name as FieldPath<T>; // every FieldName is a top-level key of T
  const set = (name: FieldName, value: unknown) =>
    setValue(path(name), value as PathValue<T, FieldPath<T>>, { shouldDirty: true, shouldValidate: formState.isSubmitted });
  const singlePa = Boolean(watch(path("single_pa")));
  const hasFa = Boolean(watch(path("has_fa")));
  const field = (name: FieldName, label: string, props: { placeholder?: string; inputMode?: "decimal" } = {}) => {
    const error = formState.errors[name as keyof typeof formState.errors];
    const message = error && "message" in error && typeof error.message === "string" ? error.message : null;
    return (
      <div className="space-y-1.5">
        <Label htmlFor={`meta-${name}`} className="font-mono text-[11px] uppercase tracking-wider text-slate-600">
          {label}
        </Label>
        <Input id={`meta-${name}`} aria-invalid={Boolean(message)} {...props} {...register(path(name))} />
        {message && <p className="text-xs text-rose-600">{message}</p>}
      </div>
    );
  };
  const toggle = (name: "single_pa" | "has_fa", label: string, hint: string) => (
    <label className="flex items-start gap-2 text-sm">
      <Checkbox
        id={`meta-${name}`}
        className="mt-0.5"
        checked={Boolean(watch(path(name)))}
        onCheckedChange={(checked) => set(name, checked === true)}
      />
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-xs text-slate-500">{hint}</span>
      </span>
    </label>
  );
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        {field("name", "Project name *")}
        <div className="space-y-1.5">
          <Label className="font-mono text-[11px] uppercase tracking-wider text-slate-600">Project type *</Label>
          <Select value={String(watch(path("project_type")))} onValueChange={(value) => set("project_type", value)}>
            <SelectTrigger className="w-full" aria-label="Project type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(PROJECT_TYPE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {field("partner_account", "Partner account")}
      </div>

      <fieldset className="space-y-3 rounded-lg border p-3">
        {toggle("single_pa", "Single PA", "Untick when the sheet lists several PAs: each store then takes its PA from the sheet.")}
        {singlePa && (
          <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
            {field("pa", "PA name *")}
            {field("pa_percentage", "PA %", { inputMode: "decimal" })}
          </div>
        )}
      </fieldset>

      <fieldset className="space-y-3 rounded-lg border p-3">
        {toggle("has_fa", "Has a field agent (FA)", "Tick to enter the field agent and their share.")}
        {hasFa && (
          <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
            {field("field_agent", "Field agent")}
            {field("fa_percentage", "FA %", { inputMode: "decimal" })}
          </div>
        )}
      </fieldset>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {field("dolphin_percentage", "Dolphin %", { inputMode: "decimal" })}
        {field("store_percentage", "Store %", { inputMode: "decimal" })}
      </div>
    </div>
  );
}
