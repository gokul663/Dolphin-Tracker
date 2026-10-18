/** Pure logic ported from the v1 legacy route planner page (removed at cutover), keyed by stop uid. */
import { isPending, type FieldDef, type RoutesBundle, type Stop } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";

export const MAP_MAX_STOPS = 10; // Google Maps directions accept origin + 8 waypoints + destination
export const INSTALLER_PALETTE = ["#f97316", "#38bdf8", "#a78bfa", "#22c55e", "#f43f5e", "#eab308", "#14b8a6", "#ec4899"];

export const US_STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};
const STATE_CODES_BY_NAME = Object.fromEntries(Object.entries(US_STATE_NAMES).map(([code, name]) => [name.toLowerCase(), code]));

export function installerColor(installers: string[], name: string): string {
  const index = installers.indexOf(name);
  return INSTALLER_PALETTE[(index < 0 ? 0 : index) % INSTALLER_PALETTE.length] as string;
}

// ---- maps links --------------------------------------------------------------------------------------------

const stopLabel = (stop: Pick<Stop, "addr" | "city" | "state" | "zip">) =>
  encodeURIComponent(`${stop.addr}, ${stop.city}, ${stop.state} ${stop.zip}`);

export function mapsUrlForStops(stops: Pick<Stop, "addr" | "city" | "state" | "zip">[]): string {
  if (!stops.length) return "#";
  const encoded = stops.map(stopLabel);
  if (encoded.length === 1) return `https://www.google.com/maps/search/?api=1&query=${encoded[0]}`;
  const waypoints = encoded.slice(1, -1).join("|");
  return `https://www.google.com/maps/dir/?api=1&origin=${encoded[0]}&destination=${encoded.at(-1)}${waypoints ? `&waypoints=${waypoints}` : ""}`;
}

/** Only pending stops (STORE-MODEL §4.2) stay on the route the installer still has to drive. */
export const routableStops = <T extends Pick<Stop, "status">>(stops: T[]) => stops.filter((stop) => isPending(stop.status));

/** Up to 10 stops per link; each chunk starts where the previous one ended (v1 `routeChunks`). */
export function routeChunks<T>(stops: T[]): { start: number; end: number; stops: T[] }[] {
  if (stops.length <= MAP_MAX_STOPS) return [{ start: 0, end: stops.length - 1, stops }];
  const chunks: { start: number; end: number; stops: T[] }[] = [];
  let start = 0;
  while (start < stops.length - 1) {
    const end = Math.min(start + MAP_MAX_STOPS - 1, stops.length - 1);
    chunks.push({ start, end, stops: stops.slice(start, end + 1) });
    if (end === stops.length - 1) break;
    start = end;
  }
  return chunks;
}

// ---- day and installer stats ---------------------------------------------------------------------------------

export interface StatusTally {
  complete: number;
  pending: number; // Upcoming, Invitation Email Sent, Shipped, Delivered: still needs a visit
  offline: number;
  other: number; // Archived, Cancelled
}

export function tally(stops: Pick<Stop, "status">[]): StatusTally {
  const counts: StatusTally = { complete: 0, pending: 0, offline: 0, other: 0 };
  for (const { status } of stops) {
    if (isPending(status)) counts.pending += 1;
    else if (status === "Completed") counts.complete += 1;
    else if (status === "Offline") counts.offline += 1;
    else counts.other += 1;
  }
  return counts;
}

export function uniqueCities(stops: Pick<Stop, "city">[]): string[] {
  return [...new Set(stops.map((stop) => stop.city.trim()))];
}

export function canonicalState(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  const code = raw.toUpperCase().replace(/\./g, "").match(/\b[A-Z]{2}\b/)?.[0] ?? "";
  if (US_STATE_NAMES[code]) return code;
  return STATE_CODES_BY_NAME[raw.toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim()] ?? "";
}

export function titleCaseCity(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase().replace(/\b([a-z])/g, (char) => char.toUpperCase());
}

export function dayStateLabel(stops: Pick<Stop, "state">[]): string {
  const states = [...new Set(stops.map((stop) => canonicalState(stop.state)).filter(Boolean))];
  if (states.length === 1) return US_STATE_NAMES[states[0] as string] ?? (states[0] as string);
  return `${states.length} states`;
}

export function addressIdentity(stop: Pick<Stop, "uid" | "addr" | "city" | "state" | "zip">): string {
  return (
    [stop.addr, stop.city, stop.state, stop.zip]
      .map((value) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim())
      .filter(Boolean)
      .join("|") || `missing-address|${stop.uid}`
  );
}

/** Records that share an exact address with another record on the same day. */
export function sameAddressRecords(stops: Pick<Stop, "uid" | "addr" | "city" | "state" | "zip">[]): number {
  const counts = new Map<string, number>();
  for (const stop of stops) counts.set(addressIdentity(stop), (counts.get(addressIdentity(stop)) ?? 0) + 1);
  return [...counts.values()].reduce((sum, count) => sum + (count > 1 ? count : 0), 0);
}

const centroid = (rows: { lat: number; lng: number }[]) => ({
  lat: rows.reduce((sum, row) => sum + row.lat, 0) / rows.length,
  lng: rows.reduce((sum, row) => sum + row.lng, 0) / rows.length,
});

/** v1 `installerTerritoryTag`: "North Atlanta", "Southwest Macon", "Central …" relative to the dominant city. */
export function territoryTag(routes: RoutesBundle["routes"], installer: string): string {
  const located = (stops: Stop[]) =>
    stops.filter((stop): stop is Stop & { lat: number; lng: number } => stop.lat !== null && stop.lng !== null);
  const own = located((routes[installer] ?? []).flat());
  if (!own.length) return "Unassigned territory";
  const cities = new Map<string, number>();
  for (const stop of own) if (stop.city.trim()) cities.set(stop.city.trim(), (cities.get(stop.city.trim()) ?? 0) + 1);
  const dominant = [...cities].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "Route area";
  const everyone = located(Object.values(routes).flat(2));
  const inCity = everyone.filter((stop) => stop.city.trim() === dominant);
  const mine = centroid(own);
  const base = centroid(inCity.length ? inCity : everyone);
  const ns = mine.lat - base.lat;
  const ew = mine.lng - base.lng;
  const threshold = 0.015;
  let direction: string;
  if (Math.abs(ns) < threshold && Math.abs(ew) < threshold) direction = "Central";
  else if (Math.abs(ns) > Math.abs(ew) * 1.5) direction = ns > 0 ? "North" : "South";
  else if (Math.abs(ew) > Math.abs(ns) * 1.5) direction = ew > 0 ? "East" : "West";
  else direction = `${ns > 0 ? "North" : "South"}${ew > 0 ? "east" : "west"}`;
  return `${direction} ${dominant}`;
}

// ---- filters -------------------------------------------------------------------------------------------------

export interface RouteFilters {
  days: string; // "1, 3 5"
  pa: string; // "" = all
  dma: string;
  venueType: string;
  state: string; // state code
  city: string; // title-cased
  q: string;
}

export const NO_FILTERS: RouteFilters = { days: "", pa: "", dma: "", venueType: "", state: "", city: "", q: "" };

export function parseDays(value: string): number[] | null {
  const days = value.split(/[, ]+/).map((part) => Number.parseInt(part, 10)).filter((day) => !Number.isNaN(day));
  return days.length ? days : null;
}

const fieldText = (stop: Stop, key: string) => String(stop.fields[key] ?? "").trim();

/** PA, DMA and venue type are store attributes since the store model v2; stops written before it carry them in
 *  `fields`. */
const storeText = (stop: Stop, key: "pa" | "dma" | "venue_type") => (stop[key] ?? "").trim() || fieldText(stop, key);

/** PA may be a comma-separated list on a stop; a filter value matches any of them. */
export function stopPAs(stop: Stop): string[] {
  return storeText(stop, "pa").split(",").map((pa) => pa.trim()).filter(Boolean);
}

export function matchesFilters(stop: Stop, filters: RouteFilters): boolean {
  if (filters.pa && !stopPAs(stop).includes(filters.pa)) return false;
  if (filters.dma && storeText(stop, "dma") !== filters.dma) return false;
  if (filters.venueType && storeText(stop, "venue_type") !== filters.venueType) return false;
  if (filters.state && canonicalState(stop.state) !== filters.state) return false;
  if (filters.city && titleCaseCity(stop.city) !== filters.city) return false;
  const q = filters.q.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    stop.display_id, stop.store_name, stop.addr, stop.city, stop.zip, stop.installer_name, STATUS_META[stop.status].label,
    stop.comment, ...Object.values(stop.fields).map((value) => String(value ?? "")),
  ];
  return haystack.join(" ").toLowerCase().includes(q);
}

export interface FilteredDay {
  day: number; // 1-based position in the installer's route
  stops: Stop[];
}

export function filterDays(days: Stop[][], filters: RouteFilters): FilteredDay[] {
  const wanted = parseDays(filters.days);
  return days
    .map((stops, index) => ({ day: index + 1, stops: stops.filter((stop) => matchesFilters(stop, filters)) }))
    .filter(({ day, stops }) => stops.length > 0 && (!wanted || wanted.includes(day)));
}

/** v1 section header numbers: active days have a pending stop; the average counts pending stops only. */
export function installerSummary(days: Stop[][], filters: RouteFilters) {
  const matching = days.map((stops) => stops.filter((stop) => matchesFilters(stop, filters)));
  const counts = tally(matching.flat());
  const activeDays = matching.filter((stops) => stops.some((stop) => isPending(stop.status))).length;
  const active = counts.pending;
  return { total: matching.flat().length, activeDays, averageActive: activeDays ? (active / activeDays).toFixed(1) : "0", ...counts };
}

export function filterOptions(routes: RoutesBundle["routes"]) {
  const stops = Object.values(routes).flat(2);
  const sorted = (values: string[]) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return {
    pa: sorted(stops.flatMap(stopPAs)),
    dma: sorted(stops.map((stop) => storeText(stop, "dma"))),
    venueType: sorted(stops.map((stop) => storeText(stop, "venue_type"))),
    state: sorted(stops.map((stop) => canonicalState(stop.state))),
    city: sorted(stops.map((stop) => titleCaseCity(stop.city))),
  };
}

// ---- export --------------------------------------------------------------------------------------------------

export function copyText(stops: Stop[]): string {
  return stops
    .map((stop, index) => `${index + 1}. ${stop.addr}, ${stop.city.trim()}, ${stop.state} ${stop.zip}${stop.store_name ? ` — ${stop.store_name}` : ""}`)
    .join("\n");
}

type Cell = string | number;

/** Route CSV columns (store model v2): identity and address, the derived status and the screen rows, what the
 *  installer needs on site, progress, the project's extra fields, then the geocode. */
function stopColumns(stop: Stop, schema: FieldDef[]): Cell[] {
  return [
    stop.external_id || stop.display_id, stop.store_name, stop.addr, stop.city.trim(), stop.state, stop.zip,
    storeText(stop, "pa"), storeText(stop, "dma"), storeText(stop, "venue_type"),
    STATUS_META[stop.status].label, stop.screens.length,
    stop.screens.map((screen) => [screen.stick_number || "—", screen.venue_id || "—", STATUS_META[screen.status].label].join(" / ")).join("; "),
    stop.onsite_contact_name, stop.onsite_contact_phone, stop.best_contact_time, stop.preferred_install_datetime,
    stop.blocked_dates_notes, stop.installation_notes, stop.comment, stop.additional_task ? "Yes" : "No",
    ...schema.map((field) => fieldText(stop, field.key)),
    stop.geocoded, stop.lat ?? "", stop.lng ?? "",
  ];
}

const STOP_HEADERS = (schema: FieldDef[]) => [
  "IBC#", "Store Name", "Address", "City", "State", "ZIP", "PA", "DMA", "Venue Type", "Status", "Screens", "Screen Rows",
  "On-site Contact", "On-site Phone", "Best Contact Time", "Preferred Install Date/Time", "Blocked Dates / Notes",
  "Installation Comments", "Comment", "Additional Task", ...schema.map((field) => field.label), "Geocoded Address", "Lat", "Lng",
];

export function dayCsvRows(installer: string, day: number, stops: Stop[], schema: FieldDef[]): Cell[][] {
  return [
    ["Day", "Stop #", "Route Owner", "Completed By", ...STOP_HEADERS(schema)],
    ...stops.map((stop, index) => [day, index + 1, installer, stop.installer_name || installer, ...stopColumns(stop, schema)]),
  ];
}

export function allCsvRows(bundle: RoutesBundle, filters: RouteFilters, schema: FieldDef[]): Cell[][] {
  const rows: Cell[][] = [["Route Owner", "Completed By", "Day", "Stop #", ...STOP_HEADERS(schema)]];
  for (const installer of bundle.installers) {
    (bundle.routes[installer] ?? []).forEach((stops, dayIndex) =>
      stops.forEach((stop, stopIndex) => {
        if (matchesFilters(stop, { ...filters, q: "", days: "" }))
          rows.push([installer, stop.installer_name || installer, dayIndex + 1, stopIndex + 1, ...stopColumns(stop, schema)]);
      }),
    );
  }
  return rows;
}

/** RFC 4180 CSV with the same formula-injection guard as the server's export. */
export function toCsv(rows: Cell[][]): string {
  const cell = (value: Cell) => {
    let text = String(value);
    if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`; // numbers (e.g. -84.4) are safe
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return rows.map((row) => row.map(cell).join(",")).join("\r\n");
}

export function filenameSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "route_planner";
}
