import { describe, expect, it } from "vitest";
import { deriveStatus, isPending, STOP_STATUSES } from "@/lib/api/types";

describe("status helpers mirror the backend", () => {
  it("derives the least-progressed status (statuses.py precedence)", () => {
    expect(STOP_STATUSES).toEqual(["Upcoming", "Invitation Email Sent", "Shipped", "Delivered", "Serviced - Needs More Work", "Offline", "Completed", "Archived", "Cancelled"]);
    expect(deriveStatus(["Completed", "Upcoming"])).toBe("Upcoming");
    expect(deriveStatus(["Completed", "Cancelled"])).toBe("Completed");
    expect(deriveStatus(["Cancelled"])).toBe("Cancelled");
    expect(deriveStatus(["Completed", "Offline"])).toBe("Offline");
    expect(deriveStatus([])).toBe("Upcoming");
  });

  it("pending is Upcoming through Serviced - Needs More Work", () => {
    expect(STOP_STATUSES.filter(isPending)).toEqual(["Upcoming", "Invitation Email Sent", "Shipped", "Delivered", "Serviced - Needs More Work"]);
  });
});
