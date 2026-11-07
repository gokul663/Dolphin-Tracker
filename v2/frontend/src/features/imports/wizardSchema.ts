import { EMPTY_META, projectMetaSchema, type ProjectMetaForm } from "@/features/projects/schema";

/** Step 1 of a new project: metadata only. Installers and the per-day cap belong to route plans. */
export const wizardDetailsSchema = projectMetaSchema;
export type WizardDetails = ProjectMetaForm;
export const EMPTY_DETAILS: WizardDetails = EMPTY_META;
