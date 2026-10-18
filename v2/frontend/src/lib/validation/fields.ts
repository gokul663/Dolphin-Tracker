/**
 * Client copy of the backend schema rules (domain/schema.py) for the Settings schema editor, plus the store name
 * rule for inline edits. Store attribute rules are in `storeFields.ts`. The server stays the authority.
 */
import type { FieldDefInput, FieldType } from "@/lib/api/types";

export const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** Backend `schema.CORE_KEYS`: the stop's own attributes, including every first-class store field (STORE-MODEL §2). */
export const CORE_KEYS = new Set([
  "uid", "display_id", "store_name", "addr", "city", "state", "zip", "lat", "lng", "geocoded", "installer", "day",
  "seq", "status", "screens", "comment", "additional_task", "installer_name", "updated_by", "route_stale", "updated_at",
  "fields", "external_id", "pa", "dma", "venue_type", "source_date", "onsite_contact_name", "onsite_contact_phone",
  "owner_name", "owner_phone", "owner_email", "best_contact_time", "preferred_language", "products_to_avoid",
  "store_ssid", "store_ssid_password", "installation_notes", "image_url", "cms_details_added", "outlet_status",
  "committed_dolphin_screens", "committed_store_tvs", "preferred_area", "ceiling_type", "ceiling_height",
  "nearest_power_outlet", "ethernet_route", "blocked_dates_notes", "preferred_install_datetime", "spot_visible",
  "power_within_6ft", "ethernet_possible", "low_volume_audio_ok", "ceiling_suitable",
]);
export const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "select", label: "Select" },
  { value: "date", label: "Date" },
  { value: "phone", label: "Phone" },
  { value: "email", label: "Email" },
];

/** Store name and address are fixed and always required (B1 / §3.1). */
export function coreError(key: "store_name" | "addr", value: string): string | null {
  if (value.trim()) return null;
  return key === "store_name" ? "Store name is required" : "Address is required";
}

/** Same checks as backend `validate_schema`. Returns problems keyed by row index ("*" for list-level).
 *  `savedKeys` (the project's current schema) may keep a now-reserved key, as on the server. */
export function schemaErrors(schema: FieldDefInput[], savedKeys: Iterable<string> = []): Record<string, string[]> {
  const grandfathered = new Set(savedKeys);
  const errors: Record<string, string[]> = {};
  const add = (index: number, message: string) => (errors[index] ??= []).push(message);
  const seen = new Map<string, number>();
  schema.forEach((field, index) => {
    if (!KEY_RE.test(field.key)) add(index, "Key must be lowercase letters, digits or _ and start with a letter");
    else if (CORE_KEYS.has(field.key) && !grandfathered.has(field.key)) add(index, `Key '${field.key}' is reserved`);
    if (seen.has(field.key)) add(index, `Duplicate key '${field.key}'`);
    seen.set(field.key, index);
    if (!field.label.trim()) add(index, "Label is required");
    if (field.type === "select" && !(field.options ?? []).length) add(index, "Select fields need at least one option");
  });
  return errors;
}

/** A schema key from a label: "Owner Phone #" → "owner_phone", made unique against `taken`. */
export function keyFromLabel(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(base)) base = `field_${base}`.replace(/_+$/, "");
  base = base.slice(0, 56) || "field";
  if (CORE_KEYS.has(base)) base = `${base}_field`;
  let key = base;
  for (let n = 2; used.has(key); n += 1) key = `${base}_${n}`;
  return key;
}

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length || from === to) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}
