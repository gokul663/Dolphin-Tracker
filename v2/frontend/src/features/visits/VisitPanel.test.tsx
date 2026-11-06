import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VisitPanel } from "@/features/visits/VisitPanel";
import { mockApi, renderWithProviders } from "@/test/render";
import { makeKpi, makeProject, makeScreen, makeStop } from "@/test/fixtures";
import { STORE_FIELDS_FOR_TESTS } from "@/test/storeFields";

const STOP = makeStop({
  uid: "u1",
  owner_name: "Sam",
  store_ssid: "ShopWiFi",
  store_ssid_password: "secret",
  fields: { cms_name: "D_005_KIOSK", tier: "Gold" },
  screens: [makeScreen({ id: "s1", stick_number: "ST-1", venue_id: "DD_1" }), makeScreen({ id: "s2", stick_number: "ST-2", venue_id: "DD_2" })],
  screen_visits: { s1: "2026-11-06T10:00:00Z" },
  last_planned_at: "2026-11-05T00:00:00Z",
});

function renderPanel() {
  const api = mockApi({
    "GET /api/projects/p1": () => ({ kpi: makeKpi(), ...makeProject() }),
    "GET /api/projects/p1/stores/u1": () => STOP,
    "GET /api/config/store-fields": () => STORE_FIELDS_FOR_TESTS,
    "GET /api/lists/categories": () => [{ name: "Power Issues", subcategories: ["TV Off"] }],
    "GET /api/lists/installers": () => ({ items: [], next_cursor: null }),
    "GET /api/lists/managers": () => ({ items: [{ value: "Zoe", created_at: "" }], next_cursor: null }),
    "GET /api/projects/p1/stores/u1/visits": () => ({
      items: [{ id: "v1", screen_id: "s1", visit_date: "2026-11-06", dd_code: "DD_1", venue_name: "V", stick_number: "ST-1", installer: "Ann",
        dolphin_manager: "Zoe", network_type: "WiFi", latest_apk: true, kiosk_mode: true, category: "Power Issues", subcategory: "TV Off",
        replaced_with: "", comments: "plugged in", route_plan_id: "plan1", project_id: "p1", stop_uid: "u1", store_name: "", addr: "", pa: "",
        fa: "", owner_name: "", owner_phone: "", owner_email: "", store_contact_name: "", store_contact_phone: "", plan_day: 1,
        created_at: "2026-11-06T10:00:00Z" }],
      next_cursor: null,
    }),
    "POST /api/projects/p1/stores/u1/visits": () => ({}),
    "PATCH /api/projects/p1/stores/u1": () => ({ ...STOP, owner_name: "Sam Lee" }),
  });
  renderWithProviders(<VisitPanel projectId="p1" stopUid="u1" planId="plan1" installer="Ann" visitDate="2026-11-06" onClose={() => {}} />);
  return api;
}

afterEach(() => vi.restoreAllMocks());

describe("VisitPanel", () => {
  it("opens on the first stick not visited yet, prefilled, beside the read-only sheet data and history", async () => {
    renderPanel();
    expect(await screen.findByRole("tab", { name: /Stick 2/, selected: true })).toBeTruthy();
    expect((screen.getByLabelText(/^DD_Code/) as HTMLInputElement).value).toBe("DD_2");
    expect((screen.getByLabelText(/^Venue Name/) as HTMLInputElement).value).toBe("D_005_KIOSK");
    expect((screen.getByLabelText("PA") as HTMLInputElement).value).toBe("North");
    const side = screen.getByRole("complementary", { name: "Store details (read only)" });
    expect(await within(side).findByText("ShopWiFi")).toBeTruthy();
    expect(within(side).queryByText("secret")).toBeNull(); // masked
    expect(within(side).getByText("Gold")).toBeTruthy(); // other imported data
    expect(await within(side).findByText(/Power Issues › TV Off/)).toBeTruthy();
  });

  it("blocks an incomplete entry, then submits one stick's visit", async () => {
    const api = renderPanel();
    await userEvent.click(await screen.findByRole("button", { name: /Submit Log Entry/ }));
    expect(screen.getByText("Network Type is required")).toBeTruthy();
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);

    await userEvent.type(screen.getByLabelText("Dolphin Manager"), "Zoe");
    await userEvent.click(screen.getByRole("radio", { name: "LTE" }));
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Latest APK" })).getByRole("radio", { name: "Yes" }));
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Set Kiosk Mode" })).getByRole("radio", { name: "No" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Category" }));
    await userEvent.click(await screen.findByRole("option", { name: "Power Issues" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Subcategory" }));
    await userEvent.click(await screen.findByRole("option", { name: "TV Off" }));
    await userEvent.click(screen.getByRole("button", { name: /Submit Log Entry/ }));
    await waitFor(() => expect(api.calls.some((call) => call.method === "POST")).toBe(true));
    expect(api.calls.find((call) => call.method === "POST")!.body).toMatchObject({
      screen_id: "s2", dd_code: "DD_2", stick_number: "ST-2", installer: "Ann", dolphin_manager: "Zoe", network_type: "LTE",
      latest_apk: true, kiosk_mode: false, category: "Power Issues", subcategory: "TV Off", route_plan_id: "plan1",
    });
  });

  it("contacts are locked until Edit, and saving updates the store", async () => {
    const api = renderPanel();
    const owner = (await screen.findByLabelText("Owner's Name")) as HTMLInputElement;
    expect(owner.readOnly).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: /^Edit$/ }));
    expect(owner.readOnly).toBe(false);
    await userEvent.clear(owner);
    await userEvent.type(owner, "Sam Lee");
    await userEvent.click(screen.getByRole("button", { name: /Save contacts/ }));
    await waitFor(() => expect(api.calls.some((call) => call.method === "PATCH")).toBe(true));
    expect(api.calls.find((call) => call.method === "PATCH")!.body).toEqual({ owner_name: "Sam Lee" });
  });
});
