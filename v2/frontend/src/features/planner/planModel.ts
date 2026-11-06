/** Pure helpers for the Route Planner (ROUTE-PLANNER §4): grouping a plan into installer → days, miles, pins, CSV. */
import { routeChunks, toCsv } from "@/features/routes/routeModel";
import type { Pin, PlanStop, PoolStore, RoutePlan, RoutePlanBundle, StartLocation, StopStatus } from "@/lib/api/types";

export const planStopKey = (stop: Pick<PlanStop, "project_id" | "stop_uid">) => `${stop.project_id}#${stop.stop_uid}`;
export const poolKey = (store: Pick<PoolStore, "project_id" | "uid">) => `${store.project_id}#${store.uid}`;

/** Visited once every stick the store had when it joined has a visit logged against this plan. */
export function isVisited(stop: Pick<PlanStop, "screen_ids" | "visited_screens">): boolean {
  return stop.screen_ids.length > 0 && stop.screen_ids.every((id) => stop.visited_screens.includes(id));
}

export type DayKind = "past" | "current" | "forecast";

export interface PlanDayView {
  number: number;
  /** The started day's date; forecast days have none yet. */
  date: string | null;
  kind: DayKind;
  start: StartLocation | null;
  stops: PlanStop[];
}

export interface InstallerView {
  name: string;
  start: StartLocation;
  days: PlanDayView[];
  total: number;
  visited: number;
}

/** installer → days in order (only days with stops), stops in visiting order. */
export function groupPlan(bundle: RoutePlanBundle): InstallerView[] {
  const { plan } = bundle;
  const current = plan.days.at(-1)?.number ?? 1;
  const dates = new Map(plan.days.map((day) => [day.number, day]));
  const names = plan.installers.map((installer) => installer.name);
  const extra = [...new Set(bundle.stops.map((stop) => stop.installer))].filter((name) => name && !names.includes(name)).sort();
  return [...plan.installers, ...extra.map((name) => ({ name, start: plan.installers[0]!.start }))].map((installer) => {
    const mine = bundle.stops.filter((stop) => stop.installer === installer.name);
    const byDay = new Map<number, PlanStop[]>();
    for (const stop of mine) byDay.set(stop.day, [...(byDay.get(stop.day) ?? []), stop]);
    const days = [...byDay.entries()]
      .sort(([a], [b]) => a - b)
      .map(([number, stops]): PlanDayView => {
        const started = dates.get(number);
        return {
          number,
          date: started?.date ?? null,
          kind: number < current ? "past" : number === current ? "current" : "forecast",
          start: started?.starts[installer.name] ?? (number === 1 ? installer.start : null),
          stops: [...stops].sort((a, b) => a.seq - b.seq),
        };
      });
    return { name: installer.name, start: installer.start, days, total: mine.length, visited: mine.filter(isVisited).length };
  });
}

const EARTH_MILES = 3958.8;
export function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return EARTH_MILES * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Straight-line miles from the start (when known) through the located stops in order. */
export function dayMiles(stops: Pick<PlanStop, "lat" | "lng">[], start?: { lat: number; lng: number } | null): number {
  const points = [...(start ? [start] : []), ...stops.flatMap((s) => (s.lat !== null && s.lng !== null ? [{ lat: s.lat, lng: s.lng }] : []))];
  let miles = 0;
  for (let i = 1; i < points.length; i += 1) miles += haversineMiles(points[i - 1]!, points[i]!);
  return Math.round(miles * 10) / 10;
}

/** Map pins for the plan: keyed by plan stop key, live store status, installer and day for the info window. */
export function planPins(bundle: RoutePlanBundle, stops: PlanStop[] = bundle.stops): Pin[] {
  return stops.flatMap((stop) =>
    stop.lat !== null && stop.lng !== null
      ? [{
          uid: planStopKey(stop),
          lat: stop.lat,
          lng: stop.lng,
          status: (bundle.store_status[planStopKey(stop)] ?? "Upcoming") as StopStatus,
          store_name: stop.store_name,
          installer: stop.installer,
          day: stop.day,
          route_plan_id: "", // every pin here is in this plan: no badge
          visit_state: isVisited(stop) ? ("visited" as const) : stop.visited_screens.length ? ("partly" as const) : ("none" as const),
        }]
      : [],
  );
}

export function poolPins(stores: PoolStore[]): Pin[] {
  return stores.flatMap((store) =>
    store.lat !== null && store.lng !== null
      ? [{
          uid: poolKey(store),
          lat: store.lat,
          lng: store.lng,
          status: store.status as StopStatus,
          store_name: store.store_name,
          installer: "",
          day: 0,
          route_plan_id: store.route_plan_id,
          visit_state: "none" as const,
        }]
      : [],
  );
}

export function fullAddress(stop: Pick<PlanStop, "addr" | "city" | "state" | "zip">): string {
  return [stop.addr, stop.city, [stop.state, stop.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

export function planCsv(bundle: RoutePlanBundle, stops: PlanStop[] = bundle.stops): string {
  const dates = new Map(bundle.plan.days.map((day) => [day.number, day.date]));
  const header = ["Installer", "Day", "Date", "Order", "Project", "IBC#", "Store", "Address", "City", "State", "Zip", "Status", "Visited"];
  const rows = [...stops]
    .sort((a, b) => a.installer.localeCompare(b.installer) || a.day - b.day || a.seq - b.seq)
    .map((stop) => [
      stop.installer,
      stop.day,
      dates.get(stop.day) ?? "forecast",
      stop.seq + 1,
      bundle.project_names[stop.project_id] ?? stop.project_id,
      stop.external_id,
      stop.store_name,
      stop.addr,
      stop.city,
      stop.state,
      stop.zip,
      bundle.store_status[planStopKey(stop)] ?? "",
      isVisited(stop) ? "yes" : stop.visited_screens.length ? "partly" : "no",
    ]);
  return toCsv([header, ...rows]);
}

/** "2026-11-06" → the next weekday after it, the default date for "Plan next day". */
export function nextWorkingDay(date: string): string {
  const next = new Date(`${date}T12:00:00Z`);
  do next.setUTCDate(next.getUTCDate() + 1);
  while (next.getUTCDay() === 0 || next.getUTCDay() === 6);
  return next.toISOString().slice(0, 10);
}

export function todayIso(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

export function planProgress(plan: RoutePlan, stops: PlanStop[]) {
  const visited = stops.filter(isVisited).length;
  return { visited, open: stops.length - visited, currentDay: plan.days.at(-1)?.number ?? 1 };
}

/** Parse "33.75, -84.39" typed into a location field (used when there is no Google key, or to paste a pin). */
export function parseCoordinates(text: string): { lat: number; lng: number } | null {
  const match = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

/** Google Maps directions for a day: from the start (when known) through the stops, split into links of at most
 *  ten points (origin + 8 waypoints + destination), each link starting where the previous one ended. */
export function dayMapsLinks(start: StartLocation | null, stops: PlanStop[]): { label: string; url: string }[] {
  const points = [
    ...(start ? [start.address || `${start.lat},${start.lng}`] : []),
    ...stops.map((stop) => (stop.lat !== null && stop.lng !== null && !stop.addr ? `${stop.lat},${stop.lng}` : fullAddress(stop))),
  ];
  if (points.length === 0) return [];
  const chunks = routeChunks(points);
  return chunks.map((chunk, index) => {
    const encoded = chunk.stops.map((point) => encodeURIComponent(point));
    const url =
      encoded.length === 1
        ? `https://www.google.com/maps/search/?api=1&query=${encoded[0]}`
        : `https://www.google.com/maps/dir/?api=1&origin=${encoded[0]}&destination=${encoded.at(-1)}${
            encoded.length > 2 ? `&waypoints=${encoded.slice(1, -1).join("|")}` : ""
          }`;
    return { label: chunks.length === 1 ? "Open route in Google Maps" : `Map ${index + 1} of ${chunks.length}`, url };
  });
}

export function copyAddresses(stops: PlanStop[]): string {
  return stops.map((stop, index) => `${index + 1}. ${fullAddress(stop)}${stop.store_name ? ` — ${stop.store_name}` : ""}`).join("\n");
}
