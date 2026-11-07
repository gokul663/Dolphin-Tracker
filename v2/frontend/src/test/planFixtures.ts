import type { PlanStop, PoolStore, RoutePlan, RoutePlanBundle } from "@/lib/api/types";

export const WEST = { address: "West depot, GA", lat: 33.75, lng: -85.0 };
export const EAST = { address: "East depot, GA", lat: 33.75, lng: -83.0 };

export function makePlanStop(uid: string, overrides: Partial<PlanStop> = {}): PlanStop {
  return {
    project_id: "p1", stop_uid: uid, external_id: `IBC-${uid}`, store_name: `Store ${uid}`, addr: `${uid} Main St`, city: "Atlanta",
    state: "GA", zip: "30303", lat: 33.7, lng: -84.4, screen_ids: [`${uid}-s1`], installer: "West", day: 1, seq: 0,
    drive_minutes: null, visited_screens: [], added_at: "2026-11-06T00:00:00Z", ...overrides,
  };
}

export function makeRoutePlan(overrides: Partial<RoutePlan> = {}): RoutePlan {
  return {
    id: "plan1", name: "GA week", status: "active", stops_per_day: 10, max_day_hours: 0, locked_days: [],
    installers: [{ name: "West", start: WEST }, { name: "East", start: EAST }],
    days: [{ number: 1, date: "2026-11-06", starts: { West: WEST, East: EAST }, stops_per_day: null, max_day_hours: null }],
    store_count: 4, version: 3, created_at: "2026-11-06T00:00:00Z", updated_at: "2026-11-06T00:00:00Z", closed_at: "",
    ...overrides,
  };
}

export function makeBundle(overrides: Partial<RoutePlanBundle> = {}): RoutePlanBundle {
  const stops = [
    makePlanStop("a", { seq: 0, visited_screens: ["a-s1"] }),
    makePlanStop("b", { seq: 1 }),
    makePlanStop("c", { day: 2, seq: 0 }),
    makePlanStop("d", { installer: "East", seq: 0, lng: -83.1 }),
  ];
  return {
    plan: makeRoutePlan(),
    stops,
    project_names: { p1: "Atlanta refresh" },
    next_starts: { West: { address: "a Main St, Atlanta, GA 30303", lat: 33.7, lng: -84.4 }, East: EAST },
    store_status: { "p1#a": "Upcoming", "p1#b": "Offline", "p1#c": "Upcoming", "p1#d": "Delivered" },
    ...overrides,
  };
}

export function makePoolStore(uid: string, overrides: Partial<PoolStore> = {}): PoolStore {
  return {
    project_id: "p1", project_name: "Atlanta refresh", uid, external_id: `IBC-${uid}`, store_name: `Store ${uid}`, addr: `${uid} Main St`,
    city: "Atlanta", state: "GA", zip: "30303", lat: 33.7, lng: -84.4, status: "Upcoming", screen_count: 1, pa: "North", dma: "",
    route_plan_id: "", ...overrides,
  };
}
