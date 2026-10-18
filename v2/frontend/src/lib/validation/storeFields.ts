/**
 * Client copy of the store field rules (backend `domain/validation.py`, STORE-MODEL §2) so the drawer fails fast
 * with the same messages. The specs come from `GET /config/store-fields`; the server stays the authority.
 */
import type { StoreFieldSpec } from "@/lib/api/types";

const PHONE_RE = /^[+()\d\s.\-/x]{7,30}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const URL_TOKEN_RE = /https?:\/\/\S+/gi;

export const TEXT_KINDS = new Set<StoreFieldSpec["kind"]>(["text", "multiline", "phone", "email", "url", "select"]);

const blank = (value: unknown) => value === null || value === undefined || (typeof value === "string" && !value.trim());

/** Why `value` breaks the field's rule, or null. Counts arrive as the input's text. */
export function storeFieldError(spec: Pick<StoreFieldSpec, "label" | "kind" | "required" | "options">, value: unknown): string | null {
  if (blank(value)) return spec.required ? `${spec.label} is required` : null;
  const text = String(value).trim();
  switch (spec.kind) {
    case "phone":
      return PHONE_RE.test(text) && (text.match(/\d/g)?.length ?? 0) >= 7 ? null : `${spec.label}: enter a valid phone number`;
    case "email":
      return EMAIL_RE.test(text) ? null : `${spec.label}: enter a valid email`;
    case "url":
      return /https?:\/\/\S+/i.test(text) ? null : `${spec.label}: needs at least one http(s):// link`;
    case "select":
      return spec.options.includes(text) ? null : `${spec.label}: must be one of ${spec.options.join(", ")}`;
    case "int":
      return /^\d+$/.test(text) ? null : `${spec.label}: must be a whole number of 0 or more`;
    default:
      return null;
  }
}

/** Every http(s) link in a raw image-URL cell (it may hold several, STORE-MODEL §2). */
export function urlTokens(value: string): string[] {
  return value.match(URL_TOKEN_RE)?.map((url) => url.replace(/[),.;]+$/, "")) ?? [];
}
