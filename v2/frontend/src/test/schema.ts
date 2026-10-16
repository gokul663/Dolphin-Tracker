import type { FieldDef } from "@/lib/api/types";

/** Mirrors backend DEFAULT_FIELD_SCHEMA (§3.1) for component tests. */
export const DEFAULT_SCHEMA_FOR_TESTS: FieldDef[] = [
  ["pa", "PA", "text"], ["venue_type", "Venue Type", "text"], ["dma", "DMA", "text"],
  ["venue_code", "Venue Code", "text"], ["owner_name", "Owner Name", "text"],
  ["owner_phone", "Owner Phone", "phone"], ["owner_email", "Owner Email", "email"], ["payee_name", "Payee Name", "text"],
].map(([key, label, type]) => ({
  key: key as string, label: label as string, type: type as FieldDef["type"], required: false, options: [],
  source_column: null,
}));
