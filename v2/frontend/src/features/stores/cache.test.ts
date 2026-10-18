import { describe, expect, it } from "vitest";
import { patchPin, patchStopInPages, patchStopInRoutes, type StopPages } from "@/features/stores/cache";
import type { Pin, RoutesBundle, Stop } from "@/lib/api/types";
import { makeStop } from "@/test/fixtures";

const stop = (uid: string): Stop => makeStop({ uid, display_id: uid, store_name: uid, installer: "A" });

describe("patchStopInPages", () => {
  const data: StopPages = {
    pages: [{ items: [stop("a"), stop("b")], next_cursor: "c1" }, { items: [stop("c")], next_cursor: null }],
    pageParams: [null, "c1"],
  };

  it("patches the stop and keeps untouched pages identical", () => {
    const next = patchStopInPages(data, "c", { status: "Completed", comment: "done" });
    expect(next?.pages[1]?.items[0]).toMatchObject({ uid: "c", status: "Completed", comment: "done" });
    expect(next?.pages[0]).toBe(data.pages[0]);
    expect(data.pages[1]?.items[0]?.status).toBe("Upcoming"); // original untouched
  });

  it("returns the same object when the stop is not cached", () => {
    expect(patchStopInPages(data, "zzz", { comment: "x" })).toBe(data);
    expect(patchStopInPages(undefined, "a", { comment: "x" })).toBeUndefined();
  });
});

describe("patchPin", () => {
  const pins: Pin[] = [{ uid: "a", lat: 1, lng: 2, status: "Upcoming", store_name: "a", installer: "A", day: 1 }];
  it("recolours on a status change and ignores other progress fields", () => {
    expect(patchPin(pins, "a", { status: "Completed" })?.[0]?.status).toBe("Completed");
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
    const next = patchStopInRoutes(bundle, "b", { status: "Completed" });
    expect(next?.routes.A?.[0]?.[1]?.status).toBe("Completed");
    expect(next?.routes.A?.[1]).toBe(bundle.routes.A?.[1]);
    expect(next?.routes.B).toBe(bundle.routes.B);
    expect(bundle.routes.A?.[0]?.[1]?.status).toBe("Upcoming");
  });

  it("returns the same bundle when the stop is not routed", () => {
    expect(patchStopInRoutes(bundle, "zzz", { status: "Completed" })).toBe(bundle);
    expect(patchStopInRoutes(undefined, "a", { status: "Completed" })).toBeUndefined();
  });
});
