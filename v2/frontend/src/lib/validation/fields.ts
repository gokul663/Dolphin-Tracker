/**
 * Client copy of the backend field rules (domain/schema.py, task B1) so forms fail fast with the same messages.
 * The server stays the authority; these only avoid a round trip.
 */
import type { FieldDef, FieldDefInput, FieldType } from "@/lib/api/types";

export const PHONE_RE = /^[+()\d\s.-]{7,20}$/;
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const CORE_KEYS = new Set([
  "uid", "display_id", "store_name", "addr", "city", "state", "zip", "lat", "lng", "geocoded", "installer", "day",
  "seq", "status", "comment", "additional_task", "installer_name", "updated_by", "route_stale", "updated_at", "fields",
]);
export const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "select", label: "Select" },
  { value: "date", label: "Date" },
  { value: "phone", label: "Phone" },
  { value: "email", label: "Email" },
];

export function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

/** Message for one value against its field definition, or null when it is fine. */
export function fieldError(field: Pick<FieldDef, "label" | "type" | "required" | "options">, value: unknown): string | null {
  if (isBlank(value)) return field.required ? `${field.label} is required` : null;
  const text = String(value).trim();
  switch (field.type) {
    case "phone":
      return PHONE_RE.test(text) ? null : `${field.label}: enter a valid phone number`;
    case "email":
      return EMAIL_RE.test(text) ? null : `${field.label}: enter a valid email`;
    case "number":
      return typeof value !== "boolean" && Number.isFinite(Number(text)) ? null : `${field.label}: must be a number`;
    case "select":
      return field.options.includes(text) ? null : `${field.label}: must be one of ${field.options.join(", ")}`;
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text)) ? null : `${field.label}: use a YYYY-MM-DD date`;
    default:
      return null;
  }
}

/** Store name and address are fixed and always required (B1 / §3.1). */
export function coreError(key: "store_name" | "addr", value: string): string | null {
  if (value.trim()) return null;
  return key === "store_name" ? "Store name is required" : "Address is required";
}

/** Same checks as backend `validate_schema`. Returns problems keyed by row index ("*" for list-level). */
export function schemaErrors(schema: FieldDefInput[]): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  const add = (index: number, message: string) => (errors[index] ??= []).push(message);
  const seen = new Map<string, number>();
  schema.forEach((field, index) => {
    if (!KEY_RE.test(field.key)) add(index, "Key must be lowercase letters, digits or _ and start with a letter");
    else if (CORE_KEYS.has(field.key)) add(index, `Key '${field.key}' is reserved`);
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
