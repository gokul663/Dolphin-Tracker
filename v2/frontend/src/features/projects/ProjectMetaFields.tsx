import type { FieldPath, PathValue, UseFormReturn } from "react-hook-form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ProjectMetaForm } from "@/features/projects/schema";
import { PROJECT_TYPE_LABELS } from "@/lib/status";

type FieldName = keyof ProjectMetaForm;

/** Metadata inputs shared by the edit dialog, the import wizard and the Settings tab. Works with any form whose
 * values include the metadata fields (Settings adds `stops_per_day`). */
export function ProjectMetaFields<T extends ProjectMetaForm>({ form }: { form: UseFormReturn<T> }) {
  const { register, formState, watch, setValue } = form;
  const path = (name: FieldName) => name as FieldPath<T>; // every FieldName is a top-level key of T
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
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {field("name", "Project name *")}
        {field("pa", "PA *", { placeholder: "Comma-separated when several" })}
        <div className="space-y-1.5">
          <Label className="font-mono text-[11px] uppercase tracking-wider text-slate-600">Project type *</Label>
          <Select
            value={String(watch(path("project_type")))}
            onValueChange={(value) =>
              setValue(path("project_type"), value as PathValue<T, FieldPath<T>>, { shouldDirty: true })
            }
          >
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
        {field("field_agent", "Field agent")}
        {field("partner_account", "Partner account")}
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {field("pa_percentage", "PA % *", { inputMode: "decimal" })}
        {field("dolphin_percentage", "Dolphin % *", { inputMode: "decimal" })}
        {field("store_percentage", "Store %", { inputMode: "decimal" })}
        {field("fa_percentage", "FA %", { inputMode: "decimal" })}
      </div>
    </div>
  );
}
