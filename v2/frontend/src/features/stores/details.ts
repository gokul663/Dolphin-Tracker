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

/** An image URL the browser can show for a pasted picture link. Google Drive and Dropbox share pages are not
 *  images, so they are turned into their thumbnail / raw forms; anything else is tried as is. */
export function previewSrc(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "drive.google.com") {
      const id = parsed.pathname.match(/\/file\/d\/([^/]+)/)?.[1] ?? parsed.searchParams.get("id");
      if (id) return `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w1000`;
    }
    if (parsed.hostname.endsWith("dropbox.com")) {
      parsed.searchParams.delete("dl");
      parsed.searchParams.set("raw", "1");
      return parsed.toString();
    }
  } catch {
    // not a URL yet (still being typed): tried as is, and the preview shows its fallback
  }
  return url;
}

/** "3 of 7 filled" for a collapsed section: text that is set, counts that are known, checks that are answered. */
export function filledCount(form: DetailsForm, specs: StoreFieldSpec[]): { filled: number; total: number } {
  const editable = editableSpecs(specs);
  const filled = editable.filter((spec) => {
    const value = form[spec.name];
    return spec.kind === "bool" ? value === true : value !== null && value !== undefined && value !== "";
  }).length;
  return { filled, total: editable.length };
}

/** Screens on the wall: done, on the wall but not reporting (Offline), or visited and still needing work (backend
 *  `INSTALLED_STATUSES`). */
export const INSTALLED_STATUSES: ReadonlySet<string> = new Set(["Completed", "Offline", "Serviced - Needs More Work"]);

/** Installed screens against the committed Dolphin screens + store TVs (backend `fulfillment`). */
export function fulfillment(stop: {
  screens: { status: string; is_dolphin_screen: boolean }[];
  committed_dolphin_screens: number | null;
  committed_store_tvs: number | null;
}) {
  const committed = (stop.committed_dolphin_screens ?? 0) + (stop.committed_store_tvs ?? 0);
  const done = stop.screens.filter((screen) => INSTALLED_STATUSES.has(screen.status));
  const installedScreens = done.filter((screen) => screen.is_dolphin_screen).length;
  const installed = done.length;
  return {
    installed,
    committed,
    /** Completed Dolphin screens and Completed store TVs, apart. */
    installedScreens,
    installedTvs: installed - installedScreens,
    /** A blank committed count is 0: anything installed meets it. */
    fulfilled: installed > 0 && installed >= committed,
  };
}

/** Who has worked on one screen, from its logged visits (newest first, as the history lists them): the latest
 *  technician with the date, and everyone who has been there. */
export function screenTechnicians(visits: { screen_id: string; installer: string; visit_date: string }[], screenId: string) {
  const mine = visits.filter((visit) => visit.screen_id === screenId && visit.installer.trim());
  const latest = mine.reduce<(typeof mine)[number] | null>((best, visit) => (!best || visit.visit_date > best.visit_date ? visit : best), null);
  const all = [...new Set(mine.map((visit) => visit.installer.trim()))];
  return { last: latest ? { name: latest.installer.trim(), date: latest.visit_date } : null, all };
}

export type ScreenPrice = { size: string; type: string; cost: number | null; is_default?: boolean };
/** The project's prices: a stick, and the Dolphin-owned screen models (size + type) from Settings. */
/** What the mounts for one screen size cost; null = none for this size, or not priced. */
export type MountPrice = { size: string; wall: number | null; ceiling: number | null };
export type HardwareCosts = {
  stick: number | null;
  screens: ScreenPrice[];
  mounts?: MountPrice[];
  /** Settings: the hardware cost is not shown in this project (the table column, the chart, the store window). */
  hidden?: boolean;
};

/** A size as the prices key it: "43", "43in", '43"' → '43"'; "" when it holds no inches. */
export function sizeLabel(value: string): string {
  const match = /^\s*(\d{2,3})(?!\d)/.exec(value ?? "");
  return match ? `${Number(match[1])}"` : "";
}

/** The Dolphin-owned models the price list has for one size (the choices after a size is picked). */
export const screenTypesFor = (costs: HardwareCosts, size: string): ScreenPrice[] =>
  costs.screens.filter((row) => row.size === sizeLabel(size) && row.type.trim() !== "");

/** The size's default model in Settings (the one marked; its first when none is): what a Dolphin screen of that size
 *  is when no type is chosen, so screens entered before types existed stay priced. */
export const defaultScreenPrice = (costs: HardwareCosts, size: string): ScreenPrice | undefined => {
  const rows = costs.screens.filter((row) => row.size === (sizeLabel(size) || '24"'));
  return rows.find((row) => row.is_default) ?? rows[0];
};

/** The price list row an installed Dolphin screen falls under: its size and type, or the size's default when no
 *  type is chosen. `null` cost = not priced (no such row, or no amount on it). */
function modelOf(costs: HardwareCosts, size: string, type: string): { label: string; price: number | null } {
  const inches = sizeLabel(size) || '24"';
  const rows = costs.screens.filter((row) => row.size === inches);
  const wanted = type.trim().toLowerCase();
  const row = wanted ? rows.find((item) => item.type.trim().toLowerCase() === wanted) : defaultScreenPrice(costs, inches);
  const name = (row?.type ?? type).trim();
  return { label: name ? `${inches} ${name} screens` : `${inches} Dolphin screens`, price: row?.cost ?? null };
}

type CostLine = { label: string; count: number; price: number | null };

/** Sticks, then one line per screen model, sizes ascending. `models` holds (size, type, count). */
function costLines(sticks: number, models: { size: string; type: string; count: number }[], costs: HardwareCosts) {
  const byLabel = new Map<string, CostLine>();
  for (const model of models) {
    if (!model.count) continue;
    const { label, price } = modelOf(costs, model.size, model.type);
    const line = byLabel.get(label) ?? { label, count: 0, price };
    line.count += model.count;
    byLabel.set(label, line);
  }
  const screens = [...byLabel.values()].sort((a, b) => parseInt(a.label, 10) - parseInt(b.label, 10) || a.label.localeCompare(b.label));
  const lines = [{ label: "Sticks", count: sticks, price: costs.stick }, ...screens].filter((line) => line.count > 0);
  const missing = lines.filter((line) => line.price === null).map((line) => (line.label === "Sticks" ? "stick" : line.label.replace(/ screens$/, " screen")));
  const total = missing.length ? null : lines.reduce((sum, line) => sum + line.count * (line.price ?? 0), 0);
  return { total, lines, missing };
}

/** What one store's installed hardware cost Dolphin: a stick for every installed screen (Completed, Offline, Needs More
 *  Work), plus the screen itself for a Dolphin screen, at its model's price. `missing` lists prices not set in
 *  Settings that the store needs (the total is then left open). */
export function hardwareCost(
  screens: { status: string; is_dolphin_screen: boolean; screen_size: string; screen_type?: string }[],
  costs: HardwareCosts,
) {
  const installed = screens.filter((screen) => INSTALLED_STATUSES.has(screen.status));
  const models = installed.filter((screen) => screen.is_dolphin_screen).map((screen) => ({ size: screen.screen_size, type: screen.screen_type ?? "", count: 1 }));
  return { ...costLines(installed.length, models, costs), installed: installed.length };
}

export const money = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** The whole project's installed hardware cost, from the header counts: a stick per installed screen, plus each
 *  installed Dolphin screen at its model's price (`installed_dolphin_by_model`, keyed `size|type`). `total` is null
 *  while a needed price is not set. */
export function projectHardwareCost(
  kpi: { installed_screens: number; installed_dolphin_by_model: Record<string, number> },
  costs: HardwareCosts,
) {
  const models = Object.entries(kpi.installed_dolphin_by_model).map(([key, count]) => {
    const [size = "", type = ""] = key.split("|");
    return { size, type, count };
  });
  const dolphinTvs = models.reduce((sum, model) => sum + model.count, 0);
  return { ...costLines(kpi.installed_screens, models, costs), sticks: kpi.installed_screens, dolphinTvs };
}

/** The hardware cost with the mounts on the installed screens added: one line per size and kind
 *  (`installed_mounts`, keyed `24"|wall`), priced from Settings' mounts. `total` is null while a needed price is not
 *  set. */
export function withMountCosts<T extends { lines: CostLine[]; missing: string[]; total: number | null }>(cost: T, installedMounts: Record<string, number>, costs: HardwareCosts): T {
  const mounts = Object.entries(installedMounts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => {
      const [size = "", kind = "wall"] = key.split("|");
      const row = (costs.mounts ?? []).find((item) => item.size === size);
      return { size, label: `${size} ${kind} mounts`, count, price: row ? (kind === "ceiling" ? row.ceiling : row.wall) : null };
    })
    .sort((a, b) => parseInt(a.size, 10) - parseInt(b.size, 10) || a.label.localeCompare(b.label));
  const lines = [...cost.lines, ...mounts.map(({ label, count, price }) => ({ label, count, price }))];
  const missing = [...cost.missing, ...mounts.filter((line) => line.price === null).map((line) => line.label.replace(/ mounts$/, " mount"))];
  return { ...cost, lines, missing, total: missing.length ? null : lines.reduce((sum, line) => sum + line.count * (line.price ?? 0), 0) };
}
