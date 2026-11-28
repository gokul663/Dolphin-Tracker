import { describe, expect, it } from "vitest";
import {
  FACET_LABELS, facetDisabled, facetOptions, facetSummary, localDay, NUMBER_LABELS, numberChipLabel, optionLabel, RANGE_LABELS,
  rangeChipLabel, resolveRange, toStoreFilters,
} from "@/features/stores/filters";
import type { StoreFilterOptions } from "@/lib/api/types";
import { NO_FACETS, NO_NUMBERS, NO_RANGES } from "@/stores/ui";

const OPTIONS: StoreFilterOptions = {
  status: [{ value: "Upcoming", count: 2 }, { value: "Invitation Email Sent", count: 1 }],
  installer: [{ value: "Ann", count: 2 }, { value: "", count: 1 }],
  pa: [{ value: "North", count: 3 }],
  state: [{ value: "GA", count: 3 }],
  city: [{ value: "Atlanta", count: 2 }],
  dma: [],
  venue_type: [],
  dd_code: [{ value: "V1", count: 1 }],
  screen_size: [],
  route: [{ value: "Not in route", count: 3 }],
  visit: [{ value: "Not visited", count: 3 }],
  bucket: [{ value: "Upcoming", count: 2 }, { value: "Offline", count: 1 }],
  install_type: [],
  mount: [{ value: "No mount needed", count: 3 }],
  fulfilled: [{ value: "No commitment", count: 3 }],
  review: [{ value: "Has review notes", count: 1 }, { value: "No review notes", count: 2 }],
  technician: [{ value: "Ann", count: 2 }, { value: "", count: 1 }],
  committed_over_installed: [],
  tag: [{ value: "Done", count: 1 }, { value: "", count: 2 }],
};

describe("filter bar helpers", () => {
  it("greys out a filter with no values unless something is still selected in it", () => {
    expect(facetDisabled(OPTIONS, "dma", [])).toBe(true);
    expect(facetDisabled(OPTIONS, "dma", ["ATL"])).toBe(false); // still untickable
    expect(facetDisabled(OPTIONS, "city", [])).toBe(false);
    expect(facetDisabled(undefined, "dma", [])).toBe(false); // not loaded yet: don't flash grey
  });

  it("greys out the Technician filter when nobody is assigned; otherwise offers No technician too", () => {
    const none = { ...OPTIONS, technician: [{ value: "", count: 614 }] };
    expect(facetOptions(none, "technician", [])).toEqual([]);
    expect(facetDisabled(none, "technician", [])).toBe(true);
    expect(facetOptions(OPTIONS, "technician", [])).toEqual([{ value: "Ann", count: 2 }, { value: "", count: 1 }]);
    expect(optionLabel("technician", "")).toBe("No technician");
  });

  it("keeps a selected value the server no longer lists, at count 0", () => {
    expect(facetOptions(OPTIONS, "city", ["Macon"])).toEqual([{ value: "Atlanta", count: 2 }, { value: "Macon", count: 0 }]);
  });

  it("labels values and summarises the selection", () => {
    expect(optionLabel("technician", "Ann")).toBe("Ann");
    expect(optionLabel("status", "Invitation Email Sent")).toBe("Invitation Email Sent");
    expect(facetSummary("dd_code", [])).toBe("DD Code");
    expect(facetSummary("state", ["GA"])).toBe("State: GA");
    expect(facetSummary("city", ["A", "B"])).toBe("City (2)");
  });

  it("builds the API query from the selection", () => {
    expect(toStoreFilters({ ...NO_FACETS, state: ["GA"], dd_code: ["V1"] }, "oak")).toMatchObject({ state: ["GA"], dd_code: ["V1"], q: "oak" });
  });

  it("names every filter in Title Case, acronyms kept", () => {
    const labels = [...Object.values(FACET_LABELS), ...Object.values(NUMBER_LABELS), ...Object.values(RANGE_LABELS)];
    for (const label of labels) {
      for (const word of label.split(/\s+/)) expect(word[0], label).toBe(word[0]!.toUpperCase());
    }
    expect([FACET_LABELS.dd_code, FACET_LABELS.venue_type, FACET_LABELS.review, FACET_LABELS.committed_over_installed, FACET_LABELS.dma, FACET_LABELS.pa]).toEqual([
      "DD Code", "Venue Type", "Review Notes", "Committed > Installed", "DMA", "PA",
    ]);
    expect(RANGE_LABELS.first_registered).toBe("First Registration Date");
  });
});

describe("number comparisons", () => {
  it("go into the request as op:number, and only with a number", () => {
    const numbers = { ...NO_NUMBERS, screens_committed: { op: "gt" as const, value: "2" }, mounts_needed: { op: "eq" as const, value: "0" }, screens_installed: { op: "lt" as const, value: "" } };
    const filters = toStoreFilters(NO_FACETS, "", false, { numbers });
    expect(filters.screens_committed).toBe("gt:2");
    expect(filters.mounts_needed).toBe("eq:0");
    expect("screens_installed" in filters).toBe(false); // empty number = off
    expect(numberChipLabel("screens_committed", numbers.screens_committed)).toBe("Screens Committed > 2");
    expect(numberChipLabel("mounts_needed", numbers.mounts_needed)).toBe("Mounts Needed = 0");
  });
});

describe("relative date ranges", () => {
  // Local calendar days; a Tuesday in March, around the end of February.
  const today = new Date(2026, 2, 3, 23, 30);

  it("turn into local calendar days, today included", () => {
    expect(localDay(today)).toBe("2026-03-03");
    expect(resolveRange({ kind: "last", n: 1, unit: "days" }, today)).toEqual({ from: "2026-03-03", to: "2026-03-03" }); // Today
    expect(resolveRange({ kind: "last", n: 2, unit: "days" }, today)).toEqual({ from: "2026-03-02", to: "2026-03-03" });
    expect(resolveRange({ kind: "last", n: 7, unit: "days" }, today)).toEqual({ from: "2026-02-25", to: "2026-03-03" });
    expect(resolveRange({ kind: "last", n: 30, unit: "days" }, today)).toEqual({ from: "2026-02-02", to: "2026-03-03" });
    expect(resolveRange({ kind: "last", n: 2, unit: "weeks" }, today)).toEqual({ from: "2026-02-18", to: "2026-03-03" });
    expect(resolveRange({ from: "2026-01-01", to: "" }, today)).toEqual({ from: "2026-01-01", to: "" }); // absolute stays
  });

  it("reach the request as dates for the injected today, and read as words in the chip", () => {
    const ranges = { ...NO_RANGES, first_registered: { kind: "last" as const, n: 7, unit: "days" as const }, last_registered: { from: "", to: "2026-01-31" } };
    expect(toStoreFilters(NO_FACETS, "", false, { ranges, today })).toMatchObject({
      first_registered_from: "2026-02-25", first_registered_to: "2026-03-03", last_registered_to: "2026-01-31",
    });
    expect(toStoreFilters(NO_FACETS, "", false, { ranges, today: new Date(2026, 2, 4) }).first_registered_from).toBe("2026-02-26"); // moves with the day
    expect(rangeChipLabel("first_registered", ranges.first_registered)).toBe("First Registration Date: Last 7 Days");
    expect(rangeChipLabel("first_registered", { kind: "last", n: 1, unit: "days" })).toBe("First Registration Date: Today");
    expect(rangeChipLabel("last_registered", { from: "2026-01-01", to: "2026-03-31" })).toBe("Last Registration Date: 2026-01-01 – 2026-03-31");
  });
});
