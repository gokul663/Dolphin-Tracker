import type { UseFormReturn } from "react-hook-form";
import { ProjectMetaFields } from "@/features/projects/ProjectMetaFields";
import type { WizardDetails } from "@/features/imports/wizardSchema";

/** Step 1 (new projects): metadata only. Installers and stops per day are set per route plan in the Route Planner. */
export function DetailsStep({ form }: { form: UseFormReturn<WizardDetails> }) {
  return (
    <div className="space-y-5">
      <ProjectMetaFields form={form} />
      <p className="text-xs text-slate-500">Installers and stops per day are chosen when you build a route plan in the Route Planner.</p>
    </div>
  );
}
