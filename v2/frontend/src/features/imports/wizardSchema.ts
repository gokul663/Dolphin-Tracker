import { z } from "zod";
import { EMPTY_META, projectMetaObject, withMetaRules } from "@/features/projects/schema";

export const wizardDetailsSchema = withMetaRules(
  projectMetaObject.extend({
    stops_per_day: z.coerce.number().int("Whole number").min(1, "At least 1").max(50, "At most 50"),
  }),
);
export type WizardDetails = z.infer<typeof wizardDetailsSchema>;
export const EMPTY_DETAILS: WizardDetails = { ...EMPTY_META, stops_per_day: 8 };
