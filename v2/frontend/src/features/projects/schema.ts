import { z } from "zod";
import type { Project, ProjectUpdate } from "@/lib/api/types";

/** Form state is strings (inputs); this turns "" into "not set" and checks the 0–100 rule the API enforces. */
const percentage = (label: string, required: boolean) =>
  z
    .string()
    .trim()
    .refine((value) => (required ? value !== "" : true), `${label} is required`)
    .refine((value) => value === "" || (Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 100), {
      message: `${label} must be between 0 and 100`,
    });

export const projectMetaSchema = z.object({
  name: z.string().trim().min(1, "Project name is required").max(200),
  pa: z.string().trim().min(1, "PA is required").max(500),
  project_type: z.enum(["new_installation", "offline", "new_installation_and_offline"]),
  field_agent: z.string().trim().max(200),
  partner_account: z.string().trim().max(200),
  pa_percentage: percentage("PA %", true),
  dolphin_percentage: percentage("Dolphin %", true),
  store_percentage: percentage("Store %", false),
  fa_percentage: percentage("FA %", false),
});

export type ProjectMetaForm = z.infer<typeof projectMetaSchema>;

const text = (value: number | null | undefined) => (value === null || value === undefined ? "" : String(value));

export function metaFormFrom(project: Project): ProjectMetaForm {
  return {
    name: project.name,
    pa: project.pa,
    project_type: project.project_type,
    field_agent: project.field_agent,
    partner_account: project.partner_account,
    pa_percentage: text(project.pa_percentage),
    dolphin_percentage: text(project.dolphin_percentage),
    store_percentage: text(project.store_percentage),
    fa_percentage: text(project.fa_percentage),
  };
}

export const EMPTY_META: ProjectMetaForm = {
  name: "", pa: "", project_type: "new_installation", field_agent: "", partner_account: "",
  pa_percentage: "", dolphin_percentage: "", store_percentage: "", fa_percentage: "",
};

/** Parsed form → API body. Optional percentages left blank are sent as null (cleared). */
export function metaPayload(form: ProjectMetaForm) {
  const optional = (value: string) => (value === "" ? null : Number(value));
  return {
    name: form.name.trim(),
    pa: form.pa.trim(),
    project_type: form.project_type,
    field_agent: form.field_agent.trim(),
    partner_account: form.partner_account.trim(),
    pa_percentage: Number(form.pa_percentage),
    dolphin_percentage: Number(form.dolphin_percentage),
    store_percentage: optional(form.store_percentage),
    fa_percentage: optional(form.fa_percentage),
  } satisfies ProjectUpdate;
}
