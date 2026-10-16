import { describe, expect, it } from "vitest";
import {
  boundsOf,
  filterByStatus,
  groupPins,
  inBounds,
  locationKey,
  markerSvg,
  statusCounts,
  toggleStatus,
} from "@/components/map/pins";
import type { Pin, StopStatus } from "@/lib/api/types";
import { STOP_STATUSES } from "@/lib/api/types";

const pin = (uid: string, lat: number, lng: number, status: StopStatus = "Incomplete"): Pin => ({
  uid, lat, lng, status, store_name: uid, installer: "Ann", day: 1,
});

describe("groupPins", () => {
  it("stacks records at the same point and mixes status to Other", () => {
    const groups = groupPins([
      pin("a", 33.7, -84.4, "Complete"),
      pin("b", 33.7000001, -84.4, "Complete"), // same to 6 decimals
      pin("c", 33.8, -84.4, "Complete"),
      pin("d", 33.8, -84.4, "Incomplete"),
      pin("e", 34, -84),
    ]);
    expect(groups.map((group) => [group.pins.map((p) => p.uid), group.status])).toEqual([
      [["a", "b"], "Complete"],
      [["c", "d"], "Other"],
      [["e"], "Incomplete"],
    ]);
    expect(locationKey(pin("x", 1.23456789, 2))).toBe("1.234568|2.000000");
  });
});

describe("legend", () => {
  const pins = [pin("a", 1, 1, "Complete"), pin("b", 1, 2), pin("c", 1, 3, "Other")];
  it("counts and filters by status", () => {
    expect(statusCounts(pins)).toEqual({ Complete: 1, Incomplete: 1, "Technical Issue": 0, Other: 1 });
    expect(filterByStatus(pins, new Set(["Complete"])).map((p) => p.uid)).toEqual(["a"]);
    expect(filterByStatus(pins, new Set())).toHaveLength(3);
  });

  it("toggles like v1, never leaving nothing visible", () => {
    const off = toggleStatus(new Set(), STOP_STATUSES, "Other");
    expect([...off].sort()).toEqual(["Complete", "Incomplete", "Technical Issue"]);
    expect([...toggleStatus(off, STOP_STATUSES, "Other")].length).toBe(4);
    expect([...toggleStatus(new Set(["Complete"]), STOP_STATUSES, "Complete")].length).toBe(4);
  });
});

describe("bounds", () => {
  it("computes and tests bounds, including across the antimeridian", () => {
    expect(boundsOf([])).toBeNull();
    const bounds = boundsOf([{ lat: 33, lng: -85 }, { lat: 34, lng: -84 }]);
    expect(bounds).toEqual({ north: 34, south: 33, east: -84, west: -85 });
    expect(inBounds({ lat: 33.5, lng: -84.5 }, bounds!)).toBe(true);
    expect(inBounds({ lat: 35, lng: -84.5 }, bounds!)).toBe(false);
    expect(inBounds({ lat: 0, lng: 179.5 }, { north: 1, south: -1, east: -179, west: 179 })).toBe(true);
  });
});

describe("markerSvg", () => {
  it("encodes colour, count and emphasis", () => {
    const svg = decodeURIComponent(markerSvg("Complete", 3, "selected"));
    expect(svg).toContain("#16a34a");
    expect(svg).toContain(">3</text>");
    expect(svg).toContain('stroke="#0f172a"');
    expect(decodeURIComponent(markerSvg("Other", 150))).toContain(">99+</text>");
    expect(decodeURIComponent(markerSvg("Other"))).toContain("></text>");
  });
});
