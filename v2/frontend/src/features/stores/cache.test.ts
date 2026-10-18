import { describe, expect, it } from "vitest";
import { patchPin, patchStopInPages, patchStopInRoutes, type StopPages } from "@/features/stores/cache";
import type { Pin, RoutesBundle, Stop } from "@/lib/api/types";

const stop = (uid: string): Stop => ({
  uid, display_id: uid, store_name: uid, addr: "", city: "", state: "", zip: "", lat: null, lng: null,
  geocoded: "", installer: "A", day: 1, seq: 0, fields: {}, status: "Incomplete", comment: "",
  additional_task: false, installer_name: "", route_stale: false, updated_at: "", updated_by: "",
});

describe("patchStopInPages", () => {
  const data: StopPages = {
    pages: [{ items: [stop("a"), stop("b")], next_cursor: "c1" }, { items: [stop("c")], next_cursor: null }],
    pageParams: [null, "c1"],
  };

  it("patches the stop and keeps untouched pages identical", () => {
    const next = patchStopInPages(data, "c", { status: "Complete", comment: "done" });
    expect(next?.pages[1]?.items[0]).toMatchObject({ uid: "c", status: "Complete", comment: "done" });
    expect(next?.pages[0]).toBe(data.pages[0]);
    expect(data.pages[1]?.items[0]?.status).toBe("Incomplete"); // original untouched
  });

  it("returns the same object when the stop is not cached", () => {
    expect(patchStopInPages(data, "zzz", { comment: "x" })).toBe(data);
    expect(patchStopInPages(undefined, "a", { comment: "x" })).toBeUndefined();
  });
});

describe("patchPin", () => {
  const pins: Pin[] = [{ uid: "a", lat: 1, lng: 2, status: "Incomplete", store_name: "a", installer: "A", day: 1 }];
  it("recolours on a status change and ignores other progress fields", () => {
    expect(patchPin(pins, "a", { status: "Complete" })?.[0]?.status).toBe("Complete");
    expect(patchPin(pins, "a", { comment: "x" })).toBe(pins);
  });
});

describe("patchStopInRoutes", () => {
  const bundle: RoutesBundle = {
    installers: ["A", "B"],
    stops_per_day: 8,
    routing_status: "ready",
    stats: {},
    routes: { A: [[stop("a"), stop("b")], [stop("c")]], B: [[stop("d")]] },
  };

  it("patches the stop in place and keeps other installers and days identical", () => {
    const next = patchStopInRoutes(bundle, "b", { status: "Complete" });
    expect(next?.routes.A?.[0]?.[1]?.status).toBe("Complete");
    expect(next?.routes.A?.[1]).toBe(bundle.routes.A?.[1]);
    expect(next?.routes.B).toBe(bundle.routes.B);
    expect(bundle.routes.A?.[0]?.[1]?.status).toBe("Incomplete");
  });

  it("returns the same bundle when the stop is not routed", () => {
    expect(patchStopInRoutes(bundle, "zzz", { status: "Complete" })).toBe(bundle);
    expect(patchStopInRoutes(undefined, "a", { status: "Complete" })).toBeUndefined();
  });
});
