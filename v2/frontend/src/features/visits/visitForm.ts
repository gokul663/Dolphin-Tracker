/** The New Log Entry form (ROUTE-PLANNER §5): one visit for one stick. Pure, so the rules are unit-tested. */
import type { Category, NetworkType, Screen, Stop, VisitInput } from "@/lib/api/types";

/** Subcategories that need the new stick or screen number (mirrors domain/lists.REPLACED_WITH_SUBCATEGORIES). */
export const REPLACED_WITH = new Set(["screen replaced with", "Stick Replaced With"]);
export const NETWORK_TYPES: NetworkType[] = ["WiFi", "Ethernet", "LTE"];

export interface VisitForm {
  screen_id: string;
  visit_date: string;
  dd_code: string;
  venue_name: string;
  stick_number: string;
  installer: string;
  dolphin_manager: string;
  network_type: NetworkType | "";
  latest_apk: boolean | null;
  kiosk_mode: boolean | null;
  category: string;
  subcategory: string;
  replaced_with: string;
  comments: string;
}

/** The sheet's "CMS NAME" column lands in the extra fields; it is the venue name the portal asks for. */
export function venueNameOf(stop: Pick<Stop, "fields">): string {
  const fields = stop.fields ?? {};
  for (const key of ["cms_name", "venue_name", "cms"]) {
    const value = fields[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function formFor(stop: Stop, screen: Screen, defaults: { installer: string; manager: string; date: string }): VisitForm {
  return {
    screen_id: screen.id,
    visit_date: defaults.date,
    dd_code: screen.venue_id,
    venue_name: venueNameOf(stop),
    stick_number: screen.stick_number,
    installer: defaults.installer || stop.installer_name || "",
    dolphin_manager: defaults.manager,
    network_type: "",
    latest_apk: null,
    kiosk_mode: null,
    category: "",
    subcategory: "",
    replaced_with: "",
    comments: "",
  };
}

const REQUIRED: [keyof VisitForm, string][] = [
  ["visit_date", "Date"],
  ["dd_code", "DD_Code"],
  ["venue_name", "Venue Name"],
  ["installer", "Installer"],
  ["stick_number", "Stick number"],
  ["dolphin_manager", "Dolphin Manager"],
  ["network_type", "Network Type"],
  ["category", "Category"],
  ["subcategory", "Subcategory"],
];

export function formErrors(form: VisitForm, categories: Category[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [key, label] of REQUIRED) {
    const value = form[key];
    if (typeof value !== "string" || !value.trim()) errors[key] = `${label} is required`;
  }
  if (form.latest_apk === null) errors.latest_apk = "Latest APK is required";
  if (form.kiosk_mode === null) errors.kiosk_mode = "Set Kiosk Mode is required";
  const category = categories.find((entry) => entry.name === form.category);
  if (form.category && !category) errors.category = "Pick a category from the list";
  if (category && form.subcategory && !category.subcategories.includes(form.subcategory)) errors.subcategory = "Pick a subcategory of this category";
  if (REPLACED_WITH.has(form.subcategory) && !form.replaced_with.trim()) errors.replaced_with = "Enter the new number";
  return errors;
}

export function toInput(form: VisitForm, planId: string): VisitInput {
  return {
    screen_id: form.screen_id,
    visit_date: form.visit_date,
    dd_code: form.dd_code.trim(),
    venue_name: form.venue_name.trim(),
    stick_number: form.stick_number.trim(),
    installer: form.installer.trim(),
    dolphin_manager: form.dolphin_manager.trim(),
    network_type: form.network_type as NetworkType,
    latest_apk: Boolean(form.latest_apk),
    kiosk_mode: Boolean(form.kiosk_mode),
    category: form.category,
    subcategory: form.subcategory,
    replaced_with: REPLACED_WITH.has(form.subcategory) ? form.replaced_with.trim() : "",
    comments: form.comments.trim(),
    route_plan_id: planId,
  };
}

export interface ContactsForm {
  owner_name: string;
  owner_phone: string;
  owner_email: string;
  onsite_contact_name: string;
  onsite_contact_phone: string;
}

export const contactsOf = (stop: Stop): ContactsForm => ({
  owner_name: stop.owner_name,
  owner_phone: stop.owner_phone,
  owner_email: stop.owner_email,
  onsite_contact_name: stop.onsite_contact_name,
  onsite_contact_phone: stop.onsite_contact_phone,
});

/** Only the contact fields that changed (the store PATCH merges the rest). */
export function contactsPatch(stop: Stop, form: ContactsForm): Partial<ContactsForm> {
  const before = contactsOf(stop);
  return Object.fromEntries(
    (Object.keys(form) as (keyof ContactsForm)[]).filter((key) => form[key].trim() !== before[key]).map((key) => [key, form[key].trim()]),
  );
}

/** "Visited" since the store's latest plan: every stick has a visit logged at or after `last_planned_at`. */
export function visitState(stop: Pick<Stop, "screens" | "screen_visits" | "last_planned_at">): "none" | "partly" | "visited" {
  const ids = stop.screens.map((screen) => screen.id);
  const since = stop.last_planned_at ?? "";
  const counted = ids.filter((id) => (stop.screen_visits[id] ?? "") !== "" && (stop.screen_visits[id] ?? "") >= since).length;
  if (!ids.length || counted === 0) return "none";
  return counted === ids.length ? "visited" : "partly";
}
