import { describe, expect, it } from "vitest";
import { patchPin, patchStopInPage, patchStopInRoutes } from "@/features/stores/cache";
import type { Pin, RoutesBundle, Stop, StorePage } from "@/lib/api/types";
import { makeStop } from "@/test/fixtures";

const stop = (uid: string): Stop => makeStop({ uid, display_id: uid, store_name: uid, installer: "A" });

describe("patchStopInPage", () => {
  const data: StorePage = { items: [stop("a"), stop("b")], next_cursor: null, total: 2, offset: 0 };

  it("patches the stop and leaves the original untouched", () => {
    const next = patchStopInPage(data, "b", { status: "Completed", comment: "done" });
    expect(next?.items[1]).toMatchObject({ uid: "b", status: "Completed", comment: "done" });
    expect(next?.items[0]).toBe(data.items[0]);
    expect(data.items[1]?.status).toBe("Upcoming");
  });

  it("returns the same object when the stop is not on the page", () => {
    expect(patchStopInPage(data, "zzz", { comment: "x" })).toBe(data);
    expect(patchStopInPage(undefined, "a", { comment: "x" })).toBeUndefined();
  });
});

describe("patchPin", () => {
  const pins: Pin[] = [{ uid: "a", lat: 1, lng: 2, status: "Upcoming", store_name: "a", installer: "A", day: 1, route_plan_id: "", visit_state: "none", screen_statuses: [] }];
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
