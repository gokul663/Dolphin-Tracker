/** Store detail editing rules (drawer and inline cells), mirroring backend B7 + B1. Pure. */
import type { FieldDef, Stop, StoreDetailsUpdate } from "@/lib/api/types";
import { coreError, fieldError } from "@/lib/validation/fields";

export interface DetailsForm {
  store_name: string;
  addr: string;
  city: string;
  state: string;
  zip: string;
  fields: Record<string, string>;
}

const asText = (value: unknown) => (value === null || value === undefined ? "" : String(value));

export function detailsFormFrom(stop: Stop, schema: FieldDef[]): DetailsForm {
  return {
    store_name: stop.store_name,
    addr: stop.addr,
    city: stop.city,
    state: stop.state,
    zip: stop.zip,
    fields: Object.fromEntries(schema.map((field) => [field.key, asText(stop.fields[field.key])])),
  };
}

/** Problems keyed by form path (`store_name`, `fields.owner_phone`); empty object means valid. */
export function detailsErrors(form: DetailsForm, schema: FieldDef[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = coreError("store_name", form.store_name);
  if (name) errors.store_name = name;
  const addr = coreError("addr", form.addr);
  if (addr) errors.addr = addr;
  for (const field of schema) {
    const message = fieldError(field, form.fields[field.key] ?? "");
    if (message) errors[`fields.${field.key}`] = message;
  }
  return errors;
}

/** Only what changed, so an untouched address is never re-geocoded and untouched fields are not rewritten. */
export function detailsPatch(stop: Stop, form: DetailsForm, schema: FieldDef[]): StoreDetailsUpdate {
  const patch: StoreDetailsUpdate = {};
  for (const key of ["store_name", "addr", "city", "state", "zip"] as const) {
    if (form[key].trim() !== stop[key]) patch[key] = form[key].trim();
  }
  const fields: Record<string, string> = {};
  for (const field of schema) {
    const next = (form.fields[field.key] ?? "").trim();
    if (next !== asText(stop.fields[field.key]).trim()) fields[field.key] = next;
  }
  if (Object.keys(fields).length) patch.fields = fields;
  return patch;
}

export function addressChanged(patch: StoreDetailsUpdate): boolean {
  return ["addr", "city", "state", "zip"].some((key) => key in patch);
}

export const addressLine = (stop: Pick<Stop, "addr" | "city" | "state" | "zip">) =>
  [stop.addr, stop.city, [stop.state, stop.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
