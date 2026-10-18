import { describe, expect, it } from "vitest";
import {
  allCsvRows,
  canonicalState,
  copyText,
  dayCsvRows,
  dayStateLabel,
  filterDays,
  filterOptions,
  installerSummary,
  mapsUrlForStops,
  NO_FILTERS,
  parseDays,
  routableStops,
  routeChunks,
  sameAddressRecords,
  tally,
  territoryTag,
  toCsv,
  uniqueCities,
} from "@/features/routes/routeModel";
import type { RoutesBundle, Stop } from "@/lib/api/types";
import { makeScreen, makeStop } from "@/test/fixtures";
import { DEFAULT_SCHEMA_FOR_TESTS as SCHEMA } from "@/test/schema";

// DMA blank on the attribute: these stops carry PA/DMA/venue type in `fields`, as stops written before v2 do.
const s = (uid: string, overrides: Partial<Stop> = {}) =>
  makeStop({ uid, display_id: uid.toUpperCase(), store_name: `Store ${uid}`, addr: `${uid} Main St`, dma: "", ...overrides });

describe("Google Maps links (v1 mapsUrlForStops / routeChunks)", () => {
  it("builds a search link for one stop and directions for several", () => {
    expect(mapsUrlForStops([])).toBe("#");
    expect(mapsUrlForStops([s("a")])).toBe("https://www.google.com/maps/search/?api=1&query=a%20Main%20St%2C%20Atlanta%2C%20GA%2030303");
    const url = new URL(mapsUrlForStops([s("a"), s("b"), s("c")]));
    expect(url.pathname).toBe("/maps/dir/");
    expect(url.searchParams.get("origin")).toBe("a Main St, Atlanta, GA 30303");
    expect(url.searchParams.get("waypoints")).toBe("b Main St, Atlanta, GA 30303");
    expect(url.searchParams.get("destination")).toBe("c Main St, Atlanta, GA 30303");
  });

  it("chunks at 10 stops, each chunk starting at the previous destination", () => {
    const stops = Array.from({ length: 23 }, (_, i) => i);
    expect(routeChunks(stops).map(({ start, end }) => [start, end])).toEqual([[0, 9], [9, 18], [18, 22]]);
    expect(routeChunks(stops.slice(0, 10))).toHaveLength(1);
    expect(routableStops([s("a", { status: "Completed" }), s("b")]).map((stop) => stop.uid)).toEqual(["b"]);
  });
});

describe("day details", () => {
  const day = [
    s("a", { status: "Completed", city: "Atlanta " }),
    s("b", { addr: "A Main St", city: "Decatur" }), // same address as a once normalised
    s("c", { status: "Offline", state: "Georgia" }),
  ];
  it("tallies statuses, cities, states and shared addresses", () => {
    expect(tally(day)).toEqual({ complete: 1, pending: 1, offline: 1, other: 0 });
    expect(uniqueCities(day)).toEqual(["Atlanta", "Decatur"]);
    expect(dayStateLabel(day)).toBe("Georgia");
    expect(dayStateLabel([s("x", { state: "TX" }), s("y")])).toBe("2 states");
    expect(sameAddressRecords([s("a"), s("a2", { addr: "a main st." }), s("b")])).toBe(2);
    expect(canonicalState("ga.")).toBe("GA");
    expect(canonicalState("north carolina")).toBe("NC");
    expect(canonicalState("Narnia")).toBe("");
  });

  it("copies addresses like v1", () => {
    expect(copyText([s("a"), s("b", { store_name: "" })])).toBe(
      "1. a Main St, Atlanta, GA 30303 — Store a\n2. b Main St, Atlanta, GA 30303",
    );
  });
});

const BUNDLE: RoutesBundle = {
  installers: ["Ann", "Bo"],
  stops_per_day: 8,
  routing_status: "ready",
  stats: {},
  routes: {
    Ann: [
      [s("a", { lat: 33.80, lng: -84.39, fields: { pa: "North, South", dma: "ATL" } }), s("b", { lat: 33.81, lng: -84.39, status: "Completed" })],
      [s("c", { lat: 33.82, lng: -84.39, city: "decatur", fields: { venue_type: "Bar" } })],
    ],
    Bo: [[s("d", { lat: 33.60, lng: -84.39, state: "AL", comment: "gate code 1234" })]],
  },
};

describe("filters and summaries", () => {
  it("parses day lists and filters by day, PA, DMA, venue type, state, city and search", () => {
    expect(parseDays("1, 3 5")).toEqual([1, 3, 5]);
    expect(parseDays("x")).toBeNull();
    const ann = BUNDLE.routes.Ann as Stop[][];
    expect(filterDays(ann, { ...NO_FILTERS, days: "2" }).map((d) => d.day)).toEqual([2]);
    expect(filterDays(ann, { ...NO_FILTERS, pa: "South" }).flatMap((d) => d.stops.map((x) => x.uid))).toEqual(["a"]);
    expect(filterDays(ann, { ...NO_FILTERS, dma: "ATL" })).toHaveLength(1);
    expect(filterDays(ann, { ...NO_FILTERS, venueType: "Bar" })[0]?.day).toBe(2);
    expect(filterDays(ann, { ...NO_FILTERS, city: "Decatur" })[0]?.stops[0]?.uid).toBe("c");
    expect(filterDays(BUNDLE.routes.Bo as Stop[][], { ...NO_FILTERS, state: "AL" })).toHaveLength(1);
    expect(filterDays(BUNDLE.routes.Bo as Stop[][], { ...NO_FILTERS, q: "GATE CODE" })).toHaveLength(1);
    expect(filterDays(ann, { ...NO_FILTERS, q: "upcoming" }).flatMap((d) => d.stops.map((x) => x.uid))).toEqual(["a", "c"]);
  });

  it("summarises an installer like v1's section header", () => {
    expect(installerSummary(BUNDLE.routes.Ann as Stop[][], NO_FILTERS)).toEqual({
      total: 3, activeDays: 2, averageActive: "1.0", complete: 1, pending: 2, offline: 0, other: 0,
    });
  });

  it("collects filter options", () => {
    expect(filterOptions(BUNDLE.routes)).toEqual({
      pa: ["North", "South"], dma: ["ATL"], venueType: ["Bar"], state: ["AL", "GA"], city: ["Atlanta", "Decatur"],
    });
  });

  it("tags territories relative to the dominant city", () => {
    expect(territoryTag(BUNDLE.routes, "Ann")).toBe("North Atlanta");
    expect(territoryTag(BUNDLE.routes, "Bo")).toBe("South Atlanta");
    expect(territoryTag({ Cy: [] }, "Cy")).toBe("Unassigned territory");
  });
});

describe("CSV export", () => {
  it("writes v2 day and all-route rows", () => {
    const day = dayCsvRows("Ann", 1, BUNDLE.routes.Ann?.[0] as Stop[], SCHEMA);
    expect(day[0]?.slice(0, 6)).toEqual(["Day", "Stop #", "Route Owner", "Completed By", "IBC#", "Store Name"]);
    for (const column of ["PA", "DMA", "Status", "Screens", "Screen Rows", "On-site Contact", "Installation Comments", "Owner Phone"]) {
      expect(day[0]).toContain(column);
    }
    const header = day[0] as string[];
    const first = day[1] as (string | number)[];
    expect(first.slice(0, 5)).toEqual([1, 1, "Ann", "Ann", "IBC-1"]);
    expect(first[header.indexOf("PA")]).toBe("North, South"); // from `fields`, as a pre-v2 stop
    expect(first[header.indexOf("Screens")]).toBe(1);
    expect(first[header.indexOf("Screen Rows")]).toBe("— / — / Upcoming");
    const v2 = dayCsvRows("Ann", 1, [s("z", { pa: "East", dma: "MCN", screens: [makeScreen({ stick_number: "S9", venue_id: "V9", status: "Shipped" })] })], SCHEMA);
    expect([v2[1]?.[header.indexOf("PA")], v2[1]?.[header.indexOf("DMA")], v2[1]?.[header.indexOf("Screen Rows")]]).toEqual(["East", "MCN", "S9 / V9 / Shipped"]);
    const all = allCsvRows(BUNDLE, { ...NO_FILTERS, state: "GA" }, SCHEMA);
    expect(all).toHaveLength(4); // header + Ann's three GA stops; Bo's AL stop filtered out
  });

  it("quotes and guards formulas but leaves numbers alone", () => {
    expect(toCsv([["a,b", 'say "hi"', "=SUM(A1)", -84.4, 1]])).toBe('"a,b","say ""hi""",\'=SUM(A1),-84.4,1');
  });
});

describe("pending set (STORE-MODEL §4.2)", () => {
  const statuses = ["Upcoming", "Invitation Email Sent", "Shipped", "Delivered", "Offline", "Completed", "Archived", "Cancelled"] as const;
  const all = statuses.map((status, index) => s(`x${index}`, { status }));

  it("routes only the four pending statuses; Offline is not routed", () => {
    expect(routableStops(all).map((stop) => stop.status)).toEqual(["Upcoming", "Invitation Email Sent", "Shipped", "Delivered"]);
  });

  it("tallies pending, completed, offline and the rest", () => {
    expect(tally(all)).toEqual({ pending: 4, complete: 1, offline: 1, other: 2 });
  });

  it("a day is active while it has a pending stop", () => {
    const summary = installerSummary([[s("a", { status: "Completed" }), s("b", { status: "Offline" })], [s("c", { status: "Shipped" })]], NO_FILTERS);
    expect((({ activeDays, averageActive, pending }) => ({ activeDays, averageActive, pending }))(summary)).toEqual({
      activeDays: 1, averageActive: "1.0", pending: 1,
    });
  });
});
