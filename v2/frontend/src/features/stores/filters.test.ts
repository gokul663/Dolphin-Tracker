import { describe, expect, it } from "vitest";
import { facetDisabled, facetOptions, facetSummary, optionLabel, toStoreFilters } from "@/features/stores/filters";
import type { StoreFilterOptions } from "@/lib/api/types";
import { NO_FACETS } from "@/stores/ui";

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
};

describe("filter bar helpers", () => {
  it("greys out a filter with no values unless something is still selected in it", () => {
    expect(facetDisabled(OPTIONS, "dma", [])).toBe(true);
    expect(facetDisabled(OPTIONS, "dma", ["ATL"])).toBe(false); // still untickable
    expect(facetDisabled(OPTIONS, "city", [])).toBe(false);
    expect(facetDisabled(undefined, "dma", [])).toBe(false); // not loaded yet: don't flash grey
  });

  it("leaves out stores without an installer: no installers at all greys the filter out", () => {
    const none = { ...OPTIONS, installer: [{ value: "", count: 614 }] };
    expect(facetOptions(none, "installer", [])).toEqual([]);
    expect(facetDisabled(none, "installer", [])).toBe(true);
    const some = { ...OPTIONS, installer: [{ value: "", count: 3 }, { value: "Ann", count: 2 }] };
    expect(facetOptions(some, "installer", [])).toEqual([{ value: "Ann", count: 2 }]);
    expect(facetDisabled(some, "installer", [])).toBe(false);
  });

  it("keeps a selected value the server no longer lists, at count 0", () => {
    expect(facetOptions(OPTIONS, "city", ["Macon"])).toEqual([{ value: "Atlanta", count: 2 }, { value: "Macon", count: 0 }]);
  });

  it("labels values and summarises the selection", () => {
    expect(optionLabel("installer", "Ann")).toBe("Ann");
    expect(optionLabel("status", "Invitation Email Sent")).toBe("Invitation Email Sent");
    expect(facetSummary("dd_code", [])).toBe("DD code");
    expect(facetSummary("state", ["GA"])).toBe("State: GA");
    expect(facetSummary("city", ["A", "B"])).toBe("City (2)");
  });

  it("builds the API query from the selection", () => {
    expect(toStoreFilters({ ...NO_FACETS, state: ["GA"], dd_code: ["V1"] }, "oak")).toMatchObject({ state: ["GA"], dd_code: ["V1"], q: "oak" });
  });
});
