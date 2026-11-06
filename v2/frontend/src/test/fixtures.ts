import type { ImportRow, Kpi, Project, ProjectSummary, Screen, ScreenStatus, Stop } from "@/lib/api/types";
import { STOP_STATUSES } from "@/lib/api/types";
import { DEFAULT_SCHEMA_FOR_TESTS } from "@/test/schema";

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1", name: "Atlanta refresh", pa: "North", project_type: "new_installation", installers: ["Ann", "Bo"],
    field_agent: "Fay", partner_account: "Acme", pa_percentage: 40, dolphin_percentage: 60, store_percentage: null,
    fa_percentage: null, stops_per_day: 8, field_schema: DEFAULT_SCHEMA_FOR_TESTS, import_mappings: {},
    routing_status: "ready", routing_job_id: "", stop_count: 3, version: 1, created_at: "2026-10-01T00:00:00+00:00",
    updated_at: "2026-10-01T00:00:00+00:00", ...overrides,
  };
}

const statusCounts = (counts: Partial<Record<ScreenStatus, number>>) =>
  Object.fromEntries(STOP_STATUSES.map((status) => [status, counts[status] ?? 0]));

export function makeKpi(overrides: Partial<Kpi> = {}): Kpi {
  return {
    total: 10, pending: 5, complete: 4, offline: 1, other: 0,
    by_status: statusCounts({ Upcoming: 5, Completed: 4, Offline: 1 }),
    screens_total: 12, screens_by_status: statusCounts({ Upcoming: 6, Completed: 5, Offline: 1 }),
    committed_dolphin_screens: 11, committed_store_tvs: 3, actual_dolphin_screens: 10, actual_store_tvs: 2,
    by_installer: { Ann: 6, Bo: 4 }, by_dma: {}, by_venue_type: {},
    address_status: { total: 10, complete: 4, pending: 6 },
    ...overrides,
  };
}

export function makeSummary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return { ...makeProject(), kpi: makeKpi(), ...overrides };
}

export function makeScreen(overrides: Partial<Screen> = {}): Screen {
  return {
    id: "sc1", stick_number: "", venue_id: "", screen_size: "", is_dolphin_screen: true, has_mount: false,
    has_ceiling_mount: false, status: "Upcoming", ...overrides,
  };
}

/** A stop as the API returns it: every store attribute present (STORE-MODEL §2). `status` follows `screens`
 *  unless both are overridden. */
export function makeStop(overrides: Partial<Stop> = {}): Stop {
  const status = overrides.status ?? "Upcoming";
  return {
    uid: "u1", display_id: "S1", external_id: "IBC-1", store_name: "Alpha Mart", addr: "1 Main St", city: "Atlanta",
    state: "GA", zip: "30303", lat: 33.75, lng: -84.39, geocoded: "1 Main St, Atlanta, GA 30303, USA",
    pa: "", dma: "ATL", venue_type: "", source_date: "", onsite_contact_name: "", onsite_contact_phone: "",
    owner_name: "", owner_phone: "", owner_email: "", best_contact_time: "", preferred_language: "",
    products_to_avoid: "", store_ssid: "", store_ssid_password: "", installation_notes: "", image_url: "",
    cms_details_added: false, outlet_status: "", committed_dolphin_screens: null, committed_store_tvs: null,
    preferred_area: "", ceiling_type: "", ceiling_height: "", nearest_power_outlet: "", ethernet_route: "",
    blocked_dates_notes: "", preferred_install_datetime: "", spot_visible: null, power_within_6ft: null,
    ethernet_possible: null, low_volume_audio_ok: null, ceiling_suitable: null,
    installer: "Ann", day: 1, seq: 0, fields: {}, screens: [makeScreen({ id: `${overrides.uid ?? "u1"}-s1`, status })],
    status, comment: "", additional_task: false, installer_name: "", route_stale: false, route_plan_id: "",
    last_planned_at: "", screen_visits: {}, last_visit_at: "",
    updated_at: "2026-10-01T00:00:00+00:00", updated_by: "", ...overrides,
  };
}

/** One verified import row as `GET /jobs/{id}/result` returns it, valid by default. */
export function makeImportRow(index: number, overrides: Partial<ImportRow> = {}): ImportRow {
  return {
    index, address: `${index} Main St`, store_name: `Store ${index}`, external_id: `IBC-${index}`, pa: "North",
    status: "valid", confidence: 100, verified_by: ["geocoding"], formatted: `${index} Main St, Atlanta, GA 30303, USA`,
    addr: `${index} Main St`, city: "Atlanta", state: "GA", zip: "30303", lat: 33.7, lng: -84.4, coordinates_source: "geocode",
    place_name: "", suggestions: [], error: "", venue_status: "Upcoming", venue_status_valid: true, venue_status_raw: "",
    installer_name: "", details: {}, screens: [{ stick_number: "", venue_id: "", status: "Upcoming" }], problems: {},
    duplicate_of: null, duplicate_reason: "", fields: {}, ...overrides,
  };
}
