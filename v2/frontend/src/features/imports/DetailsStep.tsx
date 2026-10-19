import { useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProjectMetaFields } from "@/features/projects/ProjectMetaFields";
import type { WizardDetails } from "@/features/imports/wizardSchema";

interface Props {
  form: UseFormReturn<WizardDetails>;
  installers: string[];
  onInstallersChange: (installers: string[]) => void;
}

/** Step 1 (new projects): metadata, the per-day cap and, when already known, the installers. */
export function DetailsStep({ form, installers, onInstallersChange }: Props) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const name = draft.trim();
    if (!name || installers.includes(name)) return;
    onInstallersChange([...installers, name]);
    setDraft("");
  };
  return (
    <div className="space-y-5">
      <ProjectMetaFields form={form} />
      <div className="max-w-48 space-y-1.5">
        <Label htmlFor="wizard-cap" className="font-mono text-[11px] uppercase tracking-wider text-slate-600">
          Stops per day (1–50)
        </Label>
        <Input id="wizard-cap" type="number" min={1} max={50} {...form.register("stops_per_day")} />
        {form.formState.errors.stops_per_day && (
          <p className="text-xs text-rose-600">{form.formState.errors.stops_per_day.message}</p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="wizard-installer" className="font-mono text-[11px] uppercase tracking-wider text-slate-600">
          Installers
        </Label>
        <p className="text-xs text-slate-500">
          Optional. Without installers the stores are imported unrouted; add installers later in Settings to build the routes.
        </p>
        <div className="flex gap-2">
          <Input
            id="wizard-installer"
            value={draft}
            placeholder="Installer name, then Enter"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
          />
          <Button type="button" variant="outline" onClick={add} disabled={!draft.trim() || installers.includes(draft.trim())}>
            Add
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {installers.map((name) => (
            <Badge key={name} variant="outline" className="gap-1 font-mono">
              {name}
              <button type="button" aria-label={`Remove ${name}`} onClick={() => onInstallersChange(installers.filter((n) => n !== name))}>
                <X size={12} />
              </button>
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );
}
