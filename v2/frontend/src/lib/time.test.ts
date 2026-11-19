import { describe, expect, it } from "vitest";
import { centralTime } from "@/lib/time";

describe("centralTime", () => {
  it("shows a stored UTC time as US Central, winter and summer", () => {
    expect(centralTime("2026-11-18T10:17:00+00:00")).toBe("2026-11-18 04:17 CST");
    expect(centralTime("2026-07-01T03:05:00Z")).toBe("2026-06-30 22:05 CDT"); // the day moves with the zone
    expect(centralTime("2026-11-18T10:17:00")).toBe("2026-11-18 04:17 CST"); // no zone on it: stored times are UTC
    expect(centralTime("")).toBe("");
  });
});
