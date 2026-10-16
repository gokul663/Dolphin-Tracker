import type { Project, ProjectSummary, Stop } from "@/lib/api/types";
import { DEFAULT_SCHEMA_FOR_TESTS } from "@/test/schema";

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1", name: "Atlanta refresh", pa: "North", project_type: "new_installation", installers: ["Ann", "Bo"],
    field_agent: "Fay", partner_account: "Acme", pa_percentage: 40, dolphin_percentage: 60, store_percentage: null,
    fa_percentage: null, stops_per_day: 8, field_schema: DEFAULT_SCHEMA_FOR_TESTS, routing_status: "ready",
    routing_job_id: "", stop_count: 3, version: 1, created_at: "2026-10-01T00:00:00+00:00",
    updated_at: "2026-10-01T00:00:00+00:00", ...overrides,
  };
}

export function makeSummary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    ...makeProject(),
    kpi: {
      total: 10, complete: 4, pending: 5, technical: 1, other: 0,
      by_status: { Complete: 4, Incomplete: 5, "Technical Issue": 1, Other: 0 },
      by_installer: { Ann: 6, Bo: 4 }, by_dma: {}, by_venue_type: {},
      address_status: { total: 10, complete: 4, pending: 6 },
    },
    ...overrides,
  };
}

export function makeStop(overrides: Partial<Stop> = {}): Stop {
  return {
    uid: "u1", display_id: "S1", store_name: "Alpha Mart", addr: "1 Main St", city: "Atlanta", state: "GA",
    zip: "30303", lat: 33.75, lng: -84.39, geocoded: "1 Main St, Atlanta, GA 30303, USA", installer: "Ann",
    day: 1, seq: 0, fields: { dma: "ATL" }, status: "Incomplete", comment: "", additional_task: false,
    installer_name: "", route_stale: false, updated_at: "2026-10-01T00:00:00+00:00", updated_by: "", ...overrides,
  };
}
