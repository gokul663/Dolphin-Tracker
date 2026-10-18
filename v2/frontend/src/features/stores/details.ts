/** Store detail editing (drawer), STORE-MODEL §2–§3. The field list comes from `GET /config/store-fields`. Pure. */
import type { Stop, StoreDetailsUpdate, StoreFieldSpec } from "@/lib/api/types";
import { storeFieldError, TEXT_KINDS } from "@/lib/validation/storeFields";

/** Form values by attribute name: text as string, counts as their input text, bools and tri-states as is. */
export type FormValue = string | boolean | null;
export type DetailsForm = Record<string, FormValue>;

export const ADDRESS_KEYS = ["addr", "city", "state", "zip"] as const;

type Values = Record<string, unknown>;
const valueOf = (stop: Stop, name: string): unknown => (stop as unknown as Values)[name];

export const editableSpecs = (specs: StoreFieldSpec[]) => specs.filter((spec) => spec.editable);

export function detailsFormFrom(stop: Stop, specs: StoreFieldSpec[]): DetailsForm {
  const form: DetailsForm = {};
  for (const spec of editableSpecs(specs)) {
    const value = valueOf(stop, spec.name);
    if (spec.kind === "int") form[spec.name] = value === null || value === undefined ? "" : String(value);
    else if (spec.kind === "bool") form[spec.name] = Boolean(value);
    else if (spec.kind === "tristate") form[spec.name] = value === null || value === undefined ? null : Boolean(value);
    else form[spec.name] = value === null || value === undefined ? "" : String(value);
  }
  return form;
}

/** Problems by attribute name; an empty object means the form may be saved. */
export function detailsErrors(form: DetailsForm, specs: StoreFieldSpec[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const spec of editableSpecs(specs)) {
    const message = storeFieldError(spec, form[spec.name]);
    if (message) errors[spec.name] = message;
  }
  return errors;
}

/** The form value as the API takes it: trimmed text, counts as numbers or null (unknown). */
function apiValue(spec: StoreFieldSpec, value: FormValue): string | number | boolean | null {
  if (spec.kind === "int") return typeof value === "string" && value.trim() ? Number(value.trim()) : null;
  if (TEXT_KINDS.has(spec.kind)) return typeof value === "string" ? value.trim() : "";
  return value;
}

/** Only what changed, so an untouched address is never re-geocoded and untouched values are not rewritten. */
export function detailsPatch(stop: Stop, form: DetailsForm, specs: StoreFieldSpec[]): StoreDetailsUpdate {
  const patch: Values = {};
  for (const spec of editableSpecs(specs)) {
    const next = apiValue(spec, form[spec.name] ?? null);
    const current = valueOf(stop, spec.name) ?? (spec.kind === "tristate" || spec.kind === "int" ? null : "");
    if (next !== current) patch[spec.name] = next;
  }
  return patch as StoreDetailsUpdate;
}

export function addressChanged(patch: StoreDetailsUpdate): boolean {
  return ADDRESS_KEYS.some((key) => key in patch);
}

export const addressLine = (stop: Pick<Stop, "addr" | "city" | "state" | "zip">) =>
  [stop.addr, stop.city, [stop.state, stop.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");

/** A stop's actual screen counts (STORE-MODEL §4.1): Dolphin screens are rows with `is_dolphin_screen`. */
export function actualCounts(screens: Pick<Stop["screens"][number], "is_dolphin_screen">[]) {
  const dolphin = screens.filter((screen) => screen.is_dolphin_screen).length;
  return { dolphin, tvs: screens.length - dolphin };
}
