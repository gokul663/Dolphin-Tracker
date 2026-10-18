import type { FieldDef } from "@/lib/api/types";

/** An extra-field schema for component tests: the round-1 defaults, as a project created before v2 carries them. */
export const DEFAULT_SCHEMA_FOR_TESTS: FieldDef[] = [
  ["pa", "PA", "text"], ["venue_type", "Venue Type", "text"], ["dma", "DMA", "text"],
  ["venue_code", "Venue Code", "text"], ["owner_name", "Owner Name", "text"],
  ["owner_phone", "Owner Phone", "phone"], ["owner_email", "Owner Email", "email"], ["payee_name", "Payee Name", "text"],
].map(([key, label, type]) => ({
  key: key as string, label: label as string, type: type as FieldDef["type"], required: false, options: [],
  source_column: null,
}));
