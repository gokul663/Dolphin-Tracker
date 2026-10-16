import { describe, expect, it } from "vitest";

// R2: the v2 app must not load the v1 planner page or embed anything in an iframe.
const sources = import.meta.glob(["./**/*.{ts,tsx,css}", "!./**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("legacy planner removal (R2)", () => {
  it("has sources to check", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
  });

  it("never references route-planner.html or renders an iframe", () => {
    const offenders = Object.entries(sources)
      .filter(([, text]) => /route-planner\.html|<iframe/i.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
