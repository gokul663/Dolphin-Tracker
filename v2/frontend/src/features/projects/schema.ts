import { z } from "zod";
import type { Project, ProjectUpdate } from "@/lib/api/types";

/** Form state is strings (inputs); this turns "" into "not set" and checks the 0–100 rule the API enforces. */
const percentage = (label: string) =>
  z
    .string()
    .trim()
    .refine((value) => value === "" || (Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 100), {
      message: `${label} must be between 0 and 100`,
    });

/** Only the name, the type and (for a single-PA project) the PA name are required: installers and the split are
 *  often unknown when a project starts. With several PAs each store takes its PA from the sheet's PA column. */
export const projectMetaObject = z.object({
  name: z.string().trim().min(1, "Project name is required").max(200),
  project_type: z.enum(["new_installation", "offline", "new_installation_and_offline"]),
  partner_account: z.string().trim().max(200),
  single_pa: z.boolean(),
  pa: z.string().trim().max(500),
  pa_percentage: percentage("PA %"),
  has_fa: z.boolean(),
  field_agent: z.string().trim().max(200),
  fa_percentage: percentage("FA %"),
  dolphin_percentage: percentage("Dolphin %"),
  store_percentage: percentage("Store %"),
});

type MetaValues = z.infer<typeof projectMetaObject>;

/** The cross-field rule, applied to the metadata object or to an extension of it. */
export function withMetaRules<T extends z.ZodTypeAny>(schema: T): z.ZodEffects<T> {
  return schema.superRefine((value: MetaValues, context) => {
    if (value.single_pa && !value.pa.trim()) context.addIssue({ code: "custom", path: ["pa"], message: "PA name is required" });
  });
}

export const projectMetaSchema = withMetaRules(projectMetaObject);

export type ProjectMetaForm = MetaValues;

const text = (value: number | null | undefined) => (value === null || value === undefined ? "" : String(value));

export function metaFormFrom(project: Project): ProjectMetaForm {
  const pa = project.pa.trim();
  return {
    name: project.name,
    project_type: project.project_type,
    partner_account: project.partner_account,
    single_pa: pa !== "" && !pa.includes(","),
    pa: project.pa,
    pa_percentage: text(project.pa_percentage),
    has_fa: project.field_agent.trim() !== "" || project.fa_percentage !== null,
    field_agent: project.field_agent,
    fa_percentage: text(project.fa_percentage),
    dolphin_percentage: text(project.dolphin_percentage),
    store_percentage: text(project.store_percentage),
  };
}

export const EMPTY_META: ProjectMetaForm = {
  name: "", project_type: "new_installation", partner_account: "", single_pa: true, pa: "", pa_percentage: "",
  has_fa: false, field_agent: "", fa_percentage: "", dolphin_percentage: "", store_percentage: "",
};

/** Parsed form → API body. Percentages left blank are sent as null (cleared). With several PAs the PA list is left
 *  to the stores (an edit keeps it; a new project collects it from the sheet) and there is no single PA %. */
export function metaPayload(form: ProjectMetaForm) {
  const optional = (value: string) => (value === "" ? null : Number(value));
  return {
    name: form.name.trim(),
    project_type: form.project_type,
    partner_account: form.partner_account.trim(),
    ...(form.single_pa ? { pa: form.pa.trim() } : {}),
    pa_percentage: form.single_pa ? optional(form.pa_percentage) : null,
    field_agent: form.has_fa ? form.field_agent.trim() : "",
    fa_percentage: form.has_fa ? optional(form.fa_percentage) : null,
    dolphin_percentage: optional(form.dolphin_percentage),
    store_percentage: optional(form.store_percentage),
  } satisfies ProjectUpdate;
}
