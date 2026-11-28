import { describe, expect, it } from "vitest";
import { shouldReload } from "@/lib/freshPage";

describe("shouldReload", () => {
  it("reloads the first time", () => expect(shouldReload(0, 1_000_000)).toBe(true));
  it("does not reload again within a minute", () => expect(shouldReload(1_000_000, 1_030_000)).toBe(false));
  it("reloads again later", () => expect(shouldReload(1_000_000, 1_100_000)).toBe(true));
});
