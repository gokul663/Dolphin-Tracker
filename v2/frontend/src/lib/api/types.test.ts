import { describe, expect, it } from "vitest";
import { deriveStatus, isPending, STOP_STATUSES } from "@/lib/api/types";
import { withStatus } from "@/features/stores/api";
import { makeScreen } from "@/test/fixtures";

describe("status helpers mirror the backend", () => {
  it("derives the least-progressed status (statuses.py precedence)", () => {
    expect(STOP_STATUSES).toEqual(["Upcoming", "Invitation Email Sent", "Shipped", "Delivered", "Offline", "Completed", "Archived", "Cancelled"]);
    expect(deriveStatus(["Completed", "Upcoming"])).toBe("Upcoming");
    expect(deriveStatus(["Completed", "Cancelled"])).toBe("Completed");
    expect(deriveStatus(["Cancelled"])).toBe("Cancelled");
    expect(deriveStatus(["Completed", "Offline"])).toBe("Offline");
    expect(deriveStatus([])).toBe("Upcoming");
  });

  it("pending is Upcoming through Delivered", () => {
    expect(STOP_STATUSES.filter(isPending)).toEqual(["Upcoming", "Invitation Email Sent", "Shipped", "Delivered"]);
  });

  it("withStatus sets every screen and keeps the rest of each row", () => {
    const screens = [makeScreen({ id: "a", venue_id: "V1" }), makeScreen({ id: "b", status: "Shipped", is_dolphin_screen: false })];
    expect(withStatus({ screens }, "Delivered")).toEqual([
      { ...screens[0], status: "Delivered" },
      { ...screens[1], status: "Delivered" },
    ]);
  });
});
