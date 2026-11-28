import { describe, expect, it } from "vitest";
import { tagChip, tagTone } from "@/features/stores/tagTone";

describe("tagTone", () => {
  it("gives the default tags their fixed colours, however they are written", () => {
    expect(tagTone("To Do").key).toBe("amber");
    expect(tagTone("to do").key).toBe("amber");
    expect(tagTone("In progress").key).toBe("blue");
    expect(tagTone("  IN   PROGRESS ").key).toBe("blue");
    expect(tagTone("Done").key).toBe("green");
  });

  it("gives any other tag the same palette colour every time, never a default's or grey", () => {
    for (const tag of ["Escalated", "Waiting on store", "Needs mount", "Re-visit", "x"]) {
      const first = tagTone(tag);
      expect(tagTone(tag)).toBe(first);
      expect(tagTone(tag.toUpperCase()).key).toBe(first.key);
      expect(["amber", "blue", "green", "slate"]).not.toContain(first.key);
    }
    // Pinned, so a change to the hash or the palette (which would recolour everyone's tags) is deliberate.
    expect(tagTone("Escalated").key).toBe("cyan");
    expect(tagTone("VIP").key).toBe("orange");
    expect(new Set(["Escalated", "Waiting on store", "Needs mount", "Re-visit", "Blocked", "VIP"].map((tag) => tagTone(tag).key)).size).toBeGreaterThan(1);
  });

  it("the chip carries the tone's classes", () => {
    expect(tagChip("Done")).toContain("bg-green-50");
    expect(tagChip("Done")).toContain(tagTone("Done").chip);
  });
});
