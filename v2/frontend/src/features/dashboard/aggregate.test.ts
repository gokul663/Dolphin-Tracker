import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "@/lib/api/types";
import { makeKpi } from "@/test/fixtures";
import {
  aggregateTotals,
  applySelection,
  isCompleted,
  progressPercent,
  searchProjects,
  sitesByInstaller,
  statusBreakdown,
  toggleSelection,
} from "@/features/dashboard/aggregate";

function project(id: string, overrides: Partial<ProjectSummary["kpi"]> & { installers?: string[]; name?: string; pa?: string } = {}): ProjectSummary {
  const { installers = ["Ann"], name = `Project ${id}`, pa = "North", ...kpi } = overrides;
  return {
    id, name, pa, device_pa: "", device_sync: null, project_type: "offline", installers, field_agent: "", partner_account: "",
    pa_percentage: 40, dolphin_percentage: 60, store_percentage: null, fa_percentage: null, stops_per_day: 8,
    field_schema: [], routing_status: "ready", routing_job_id: "", stop_count: 0, version: 1,
    created_at: "", updated_at: "",
    import_mappings: {},
    kpi: makeKpi({
      total: 0, complete: 0, pending: 0, offline: 0, other: 0, by_status: {}, by_installer: {}, ...kpi,
    }),
  };
}

const A = project("a", {
  total: 10, complete: 4, pending: 5, offline: 1, installers: ["Ann", "Bo"], by_installer: { Ann: 6, Bo: 4 },
  by_status: { Upcoming: 3, Shipped: 2, Completed: 4, Offline: 1 },
});
const B = project("b", {
  total: 3, complete: 3, installers: ["Bo"], by_installer: { Bo: 3 }, name: "Atlanta wave", pa: "South",
  by_status: { Completed: 3 },
});
const EMPTY = project("c");

describe("dashboard aggregation", () => {
  it("totals projects, sites and unique installers", () => {
    expect(aggregateTotals([A, B])).toMatchObject({ projects: 2, sites: 13, installers: 2, complete: 7, pending: 5, offline: 1, other: 0 });
    expect(aggregateTotals([A, B]).byStatus).toMatchObject({ Upcoming: 3, Shipped: 2, Completed: 7, Offline: 1, Cancelled: 0 });
  });

  it("sums installers across projects and drops empty status slices", () => {
    expect(sitesByInstaller([A, B])).toEqual([{ name: "Ann", value: 6 }, { name: "Bo", value: 7 }]);
    // All eight statuses in precedence order, empty ones dropped.
    expect(statusBreakdown(aggregateTotals([A])).map((entry) => entry.status)).toEqual(["Upcoming", "Shipped", "Offline", "Completed"]);
  });

  it("classifies completed projects and progress like v1", () => {
    expect([isCompleted(A), isCompleted(B), isCompleted(EMPTY)]).toEqual([false, true, false]);
    expect([progressPercent(A), progressPercent(B), progressPercent(EMPTY)]).toEqual([40, 100, 0]);
  });

  it("searches name, PA and type label", () => {
    expect(searchProjects([A, B], "atlanta").map((p) => p.id)).toEqual(["b"]);
    expect(searchProjects([A, B], "south").map((p) => p.id)).toEqual(["b"]);
    expect(searchProjects([A, B], "offline")).toHaveLength(2);
    expect(searchProjects([A, B], " ")).toHaveLength(2);
  });

  it("toggles the KPI filter starting from all", () => {
    const ids = ["a", "b", "c"];
    expect(toggleSelection(null, ids, "b")).toEqual(["a", "c"]);
    expect(toggleSelection(["a"], ids, "b")).toEqual(["a", "b"]);
    expect(applySelection([A, B], null)).toHaveLength(2);
    expect(applySelection([A, B], ["b"]).map((p) => p.id)).toEqual(["b"]);
    expect(applySelection([A, B], [])).toEqual([]);
  });
});
