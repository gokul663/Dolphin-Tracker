import { describe, expect, it } from "vitest";
import {
  boundsOf,
  changedStyles,
  filterByStatus,
  groupPins,
  inBounds,
  locationKey,
  locationSignature,
  markerStyles,
  markerSvg,
  markerZIndex,
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

describe("marker signatures and style diffs", () => {
  const base: Pin[] = [
    { uid: "a", lat: 33.7, lng: -84.4, status: "Incomplete", store_name: "A", installer: "Ann", day: 1 },
    { uid: "b", lat: 33.9, lng: -84.1, status: "Incomplete", store_name: "B", installer: "Ann", day: 1 },
  ];

  it("ignores status in the location signature, so a recolour never rebuilds or refits", () => {
    const recoloured = base.map((pin) => (pin.uid === "a" ? { ...pin, status: "Complete" as const } : pin));
    expect(locationSignature(groupPins(recoloured))).toBe(locationSignature(groupPins(base)));
    const moved = base.map((pin) => (pin.uid === "a" ? { ...pin, lat: 34.1 } : pin));
    expect(locationSignature(groupPins(moved))).not.toBe(locationSignature(groupPins(base)));
  });

  it("restyles only the markers whose status or emphasis changed", () => {
    const groups = groupPins(base);
    const [keyA, keyB] = groups.map((group) => group.key);
    const idle = markerStyles(groups);
    expect(changedStyles(new Map(), idle)).toEqual([keyA, keyB]); // first paint styles everything
    expect(changedStyles(idle, markerStyles(groups))).toEqual([]);

    const hoverA = markerStyles(groups, null, "a");
    expect(changedStyles(idle, hoverA)).toEqual([keyA]);
    const hoverB = markerStyles(groups, null, "b");
    expect(changedStyles(hoverA, hoverB)).toEqual([keyA, keyB]); // A back to normal, B emphasised
    expect(hoverB.get(keyB as string)?.emphasis).toBe("hover");
    expect(markerStyles(groups, "b", "b").get(keyB as string)?.emphasis).toBe("selected");

    const recoloured = groupPins(base.map((pin) => (pin.uid === "b" ? { ...pin, status: "Complete" as const } : pin)));
    expect(changedStyles(idle, markerStyles(recoloured))).toEqual([keyB]);
  });

  it("raises stacks and emphasised markers above single pins", () => {
    expect(markerZIndex({ status: "Complete", count: 1, emphasis: "normal" })).toBe(1);
    expect(markerZIndex({ status: "Complete", count: 3, emphasis: "normal" })).toBe(1003);
    expect(markerZIndex({ status: "Complete", count: 1, emphasis: "hover" })).toBe(5000);
  });
});
