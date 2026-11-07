import { describe, expect, it } from "vitest";
import {
  dayDriveMinutes,
  dayMapsLinks,
  dayMiles,
  formatDuration,
  groupPlan,
  isVisited,
  nextWorkingDay,
  parseCoordinates,
  parseMaxHours,
  planCsv,
  planPins,
} from "@/features/planner/planModel";
import { makeBundle, makePlanStop, makeRoutePlan, WEST } from "@/test/planFixtures";

describe("planModel", () => {
  it("visited means every stick of the store has a visit in this plan", () => {
    expect(isVisited(makePlanStop("a", { screen_ids: ["x", "y"], visited_screens: ["x"] }))).toBe(false);
    expect(isVisited(makePlanStop("a", { screen_ids: ["x", "y"], visited_screens: ["y", "x"] }))).toBe(true);
    expect(isVisited(makePlanStop("a", { screen_ids: [], visited_screens: [] }))).toBe(false);
  });

  it("groups by installer and day, marking done, today and forecast days", () => {
    const bundle = makeBundle({
      plan: makeRoutePlan({
        days: [
          { number: 1, date: "2026-11-06", starts: { West: WEST }, stops_per_day: null, max_day_hours: null },
          { number: 2, date: "2026-11-09", starts: { West: { address: "Hotel", lat: 34, lng: -84 } }, stops_per_day: null, max_day_hours: null },
        ],
      }),
      stops: [makePlanStop("a"), makePlanStop("b", { day: 2, seq: 1 }), makePlanStop("c", { day: 2, seq: 0 }), makePlanStop("d", { day: 3 })],
    });
    const [west, east] = groupPlan(bundle);
    expect(west!.days.map((d) => [d.number, d.kind, d.date])).toEqual([
      [1, "past", "2026-11-06"],
      [2, "current", "2026-11-09"],
      [3, "forecast", null],
    ]);
    expect(west!.days[1]!.stops.map((s) => s.stop_uid)).toEqual(["c", "b"]);
    expect(west!.days[1]!.start?.address).toBe("Hotel");
    expect(east!.days).toEqual([]);
  });

  it("miles run from the start through the stops", () => {
    const stops = [makePlanStop("a", { lat: 33, lng: -84 }), makePlanStop("b", { lat: 33.1, lng: -84 })];
    expect(dayMiles(stops)).toBeCloseTo(6.9, 1);
    expect(dayMiles(stops, { lat: 32.9, lng: -84 })).toBeCloseTo(13.8, 1);
    expect(dayMiles([makePlanStop("x", { lat: null, lng: null })])).toBe(0);
  });

  it("maps links start at the installer's start and split after ten points", () => {
    const stops = Array.from({ length: 12 }, (_, i) => makePlanStop(`s${i}`));
    const links = dayMapsLinks(WEST, stops);
    expect(links).toHaveLength(2);
    expect(links[0]!.url).toContain(`origin=${encodeURIComponent(WEST.address)}`);
    expect(links[1]!.label).toBe("Map 2 of 2");
    expect(dayMapsLinks(null, [])).toEqual([]);
  });

  it("pins use the live store status; CSV lists every stop with its visit state", () => {
    const bundle = makeBundle();
    expect(planPins(bundle).find((pin) => pin.uid === "p1#b")?.status).toBe("Offline");
    const csv = planCsv(bundle).split("\r\n");
    expect(csv[0]).toContain("Installer,Day,Date,Order,Project");
    expect(csv.find((line) => line.includes("Store a"))).toContain("2026-11-06");
    expect(csv.find((line) => line.includes("Store a"))).toMatch(/,yes$/);
    expect(csv.find((line) => line.includes("Store c"))).toContain("forecast");
  });

  it("next working day skips the weekend; coordinates parse", () => {
    expect(nextWorkingDay("2026-11-06")).toBe("2026-11-09"); // Friday → Monday
    expect(nextWorkingDay("2026-11-09")).toBe("2026-11-10");
    expect(parseCoordinates(" 33.75, -84.39 ")).toEqual({ lat: 33.75, lng: -84.39 });
    expect(parseCoordinates("33.75 -84.39")).toEqual({ lat: 33.75, lng: -84.39 });
    expect(parseCoordinates("123 Main St")).toBeNull();
    expect(parseCoordinates("95, 10")).toBeNull();
  });
});

describe("driving time", () => {
  it("sums known drive minutes and formats them", () => {
    expect(dayDriveMinutes([makePlanStop("a", { drive_minutes: 50 }), makePlanStop("b", { drive_minutes: 75 })])).toBe(125);
    expect(dayDriveMinutes([makePlanStop("a")])).toBeNull(); // laid out before drive times were kept
    expect(formatDuration(125)).toBe("2h 05m");
    expect(formatDuration(45)).toBe("45m");
  });

  it("parses the max-hours field: blank is no limit", () => {
    expect(parseMaxHours("")).toBe(0);
    expect(parseMaxHours("6.5")).toBe(6.5);
    expect(parseMaxHours("25")).toBeNull();
    expect(parseMaxHours("-1")).toBeNull();
  });
});
