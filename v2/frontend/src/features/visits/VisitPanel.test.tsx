import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VisitPanel } from "@/features/visits/VisitPanel";
import { mockApi, renderWithProviders } from "@/test/render";
import { makeKpi, makeProject, makeScreen, makeStop } from "@/test/fixtures";
import { STORE_FIELDS_FOR_TESTS } from "@/test/storeFields";
import type { Role } from "@/lib/api/types";

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

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear(); // the remembered Dolphin manager
});

describe("VisitPanel", () => {
  it("opens on the first stick not visited yet, prefilled, beside the read-only sheet data and history", async () => {
    renderPanel();
    expect(await screen.findByRole("tab", { name: /Stick 2/, selected: true })).toBeTruthy();
    expect((screen.getByLabelText(/^DD_Code/) as HTMLInputElement).value).toBe("DD_2");
    expect((screen.getByLabelText(/^Venue Name/) as HTMLInputElement).value).toBe("D_005_KIOSK");
    expect((screen.getByLabelText("PA") as HTMLInputElement).value).toBe("North");
    const side = screen.getByRole("complementary", { name: "Store details (read only)" });
    const wifi = screen.getByRole("group", { name: "Store WiFi" });
    expect((within(wifi).getByLabelText("WiFi name (SSID)") as HTMLInputElement).value).toBe("ShopWiFi");
    const password = within(wifi).getByLabelText("WiFi password") as HTMLInputElement;
    expect([password.type, password.readOnly]).toEqual(["password", true]); // masked and locked
    expect(within(side).queryByText("ShopWiFi")).toBeNull(); // on the form now, not the side panel
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
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Dagent installed" })).getByRole("radio", { name: "Yes" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Category" }));
    await userEvent.click(await screen.findByRole("option", { name: "Power Issues" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Subcategory" }));
    await userEvent.click(await screen.findByRole("option", { name: "TV Off" }));
    await userEvent.click(screen.getByRole("button", { name: /Submit Log Entry/ }));
    await waitFor(() => expect(api.calls.some((call) => call.method === "POST")).toBe(true));
    expect(api.calls.find((call) => call.method === "POST")!.body).toMatchObject({
      screen_id: "s2", dd_code: "DD_2", stick_number: "ST-2", installer: "Ann", dolphin_manager: "Zoe", network_type: "LTE",
      latest_apk: true, kiosk_mode: false, dagent_installed: true, category: "Power Issues", subcategory: "TV Off", route_plan_id: "plan1",
    });
  });

  it("owner, store contact and WiFi each unlock with their own Edit, and saving updates the store", async () => {
    const api = renderPanel();
    const owner = (await screen.findByLabelText("Owner's Name")) as HTMLInputElement;
    const storeContact = screen.getByLabelText("Store Contact Name") as HTMLInputElement;
    expect([owner.readOnly, storeContact.readOnly]).toEqual([true, true]);
    await userEvent.click(screen.getByRole("button", { name: "Edit Owner" }));
    expect([owner.readOnly, storeContact.readOnly]).toEqual([false, true]); // only the owner group unlocks
    await userEvent.clear(owner);
    await userEvent.type(owner, "Sam Lee");
    await userEvent.click(screen.getByRole("button", { name: "Save Owner" }));
    await waitFor(() => expect(api.calls.filter((call) => call.method === "PATCH")).toHaveLength(1));
    expect(api.calls.find((call) => call.method === "PATCH")!.body).toEqual({ owner_name: "Sam Lee" });

    await userEvent.click(screen.getByRole("button", { name: "Edit Store WiFi" }));
    const password = screen.getByLabelText("WiFi password") as HTMLInputElement;
    await userEvent.click(screen.getByRole("button", { name: "Show WiFi password" }));
    expect(password.value).toBe("secret");
    await userEvent.clear(password);
    await userEvent.type(password, "newpass");
    await userEvent.click(screen.getByRole("button", { name: "Save Store WiFi" }));
    await waitFor(() => expect(api.calls.filter((call) => call.method === "PATCH")).toHaveLength(2));
    expect(api.calls.filter((call) => call.method === "PATCH")[1]!.body).toEqual({ store_ssid_password: "newpass" });
  });
});

describe("VisitPanel from a route plan", () => {
  const PLAN_VISIT = { id: "v1", screen_id: "s1", visit_date: "2026-11-06", dd_code: "DD_100", venue_name: "V", stick_number: "ST-1", installer: "Ann",
    dolphin_manager: "Zoe", network_type: "WiFi", latest_apk: true, kiosk_mode: true, dagent_installed: true, wifi_ssid: "", wifi_password: "",
    category: "Power Issues", subcategory: "TV Off", replaced_with: "", comments: "plugged in", route_plan_id: "plan1", outcome: "done",
    project_id: "p1", stop_uid: "u1", store_name: "", addr: "", pa: "", fa: "", owner_name: "", owner_phone: "", owner_email: "",
    store_contact_name: "", store_contact_phone: "", plan_day: 1, created_at: "2026-11-06T10:00:00Z" };

  function renderFromPlan(stop = STOP, visits: unknown[] = [], role: Role = "super_admin") {
    const api = mockApi({
      "GET /api/projects/p1": () => ({ kpi: makeKpi(), ...makeProject({ field_agent: "Fay" }) }),
      "GET /api/projects/p1/stores/u1": () => stop,
      "GET /api/config/store-fields": () => STORE_FIELDS_FOR_TESTS,
      "GET /api/lists/categories": () => [{ name: "Power Issues", subcategories: ["TV Off"] }],
      "GET /api/lists/installers": () => ({ items: [], next_cursor: null }),
      "GET /api/lists/managers": () => ({ items: [{ value: "Zoe", created_at: "" }], next_cursor: null }),
      "GET /api/projects/p1/stores/u1/visits": () => ({ items: visits, next_cursor: null }),
      "POST /api/projects/p1/stores/u1/visits": () => ({}),
      "PUT /api/projects/p1/stores/u1/screens": () => stop,
      "PATCH /api/projects/p1/stores/u1": () => stop,
      // The Dolphin data's record for DD_100 (the planner's all-venues list); other codes are not in it.
      "GET /api/projects/venues/stores/v-DD_100": () =>
        makeStop({ uid: "v-DD_100", store_name: "CMS Mart", pa: "ATM Boss", dma: "Macon", geocoded: "1 Elm St, Macon, GA 31201", screens: [makeScreen({ id: "v-DD_100-s1", venue_id: "DD_100", cms_name: "D_005_KIOSK", status: "Offline" })] }),
    });
    renderWithProviders(<VisitPanel projectId="p1" stopUid="u1" planId="plan1" installer="Ann" visitDate="2026-11-06" onClose={() => {}} plan={{ state: "route" }} />, { role });
    return { api };
  }

  const fillLog = async (form: HTMLElement) => {
    await userEvent.click(within(within(form).getByRole("radiogroup", { name: "Latest APK" })).getByRole("radio", { name: "Yes" }));
    await userEvent.click(within(within(form).getByRole("radiogroup", { name: "Set Kiosk Mode" })).getByRole("radio", { name: "No" }));
    await userEvent.click(within(within(form).getByRole("radiogroup", { name: "Dagent installed" })).getByRole("radio", { name: "Yes" }));
    await userEvent.click(within(form).getByRole("combobox", { name: "Category" }));
    await userEvent.click(await screen.findByRole("option", { name: "Power Issues" }));
    await userEvent.click(within(form).getByRole("combobox", { name: "Subcategory" }));
    await userEvent.click(await screen.findByRole("option", { name: "TV Off" }));
  };

  it("shows what to bring, the screens as lines, and on the right who the store is, its name, WiFi and history", async () => {
    const stop = makeStop({
      ...STOP,
      venue_type: "Bar",
      wall_mounts_needed: null, wall_24_mounts_needed: null, ceiling_mounts_needed: 2,
      screens: [
        makeScreen({ id: "s1", status: "Upcoming", screen_size: '43"', screen_type: "Dell", has_mount: true, venue_id: "DD_100", stick_number: "ST-1" }),
        makeScreen({ id: "s2", status: "Upcoming", screen_size: "", is_dolphin_screen: false }),
        makeScreen({ id: "s3", status: "Completed", screen_size: '50"' }),
      ],
    });
    const { api } = renderFromPlan(stop, [PLAN_VISIT]);
    const need = await screen.findByRole("region", { name: "Inventory needed" });
    expect(need.textContent).toContain("Sticks2"); // one per Upcoming screen
    expect(need.textContent).toContain('1 × 43" Dell');
    expect(need.textContent).toContain("2 × Ceiling"); // the number typed on the store

    // The screens are lines, each with its own Log visit; the one logged in this plan says what it was left as.
    const lines = within(screen.getByRole("list", { name: "Screens of this store" })).getAllByRole("listitem");
    expect(lines).toHaveLength(3);
    await waitFor(() => expect(lines[0]!.textContent).toContain("Done"));
    expect(lines[0]!.textContent).toContain("Stick ST-1 · DD_100");
    expect(lines[1]!.textContent).toContain("Not logged");
    expect(screen.getByText(/1 of 3 screens logged/)).toBeTruthy();
    expect(screen.queryByLabelText("PA")).toBeNull(); // nothing of PA / FA to fill in: they are on the right

    const side = screen.getByRole("complementary", { name: "Store details" });
    const identity = within(side).getByRole("region", { name: "Store" });
    await waitFor(() => expect(identity.textContent).toContain("from the CMS (DD_100)"));
    expect(identity.textContent).toContain("PAATM Boss");
    expect(identity.textContent).toContain("FAFay");
    // Every stick's history is on the right, with what the visit left the screen as.
    expect((await within(side).findByText(/Power Issues › TV Off/)).closest("li")!.textContent).toContain("Done");
    expect(within(side).getByRole("group", { name: "Store WiFi" })).toBeTruthy();

    // The name is not edited here, and the venue type is the store's, shown with it (not on each screen).
    expect(within(side).queryByRole("button", { name: "Edit Store name" })).toBeNull();
    expect(identity.textContent).toContain("Venue typeBar");
    await userEvent.click(screen.getByRole("button", { name: "Log visit for screen 2" }));
    expect(within(screen.getByRole("group", { name: "Log visit for screen 2" })).queryByLabelText("Venue type")).toBeNull();
    await userEvent.click(within(screen.getByRole("group", { name: "Log visit for screen 2" })).getByRole("button", { name: "Cancel" }));
    expect(api.calls.some((call) => call.method === "PATCH")).toBe(false);

    // Store level on the left: just the comment and what was used.
    expect(screen.getByRole("textbox", { name: "Store comment" })).toBeTruthy();
    const used = screen.getByRole("group", { name: "Used at this store" });
    expect(within(used).getByLabelText("Screens used, worked out").textContent).toBe("1");
  });

  it("logs one screen from its line: network, software, issue, Done or Incomplete; the store's WiFi unless another is ticked", async () => {
    const { api } = renderFromPlan(makeStop({ ...STOP, screens: [makeScreen({ id: "s1", status: "Offline", stick_number: "ST-1", venue_id: "DD_100" }), makeScreen({ id: "s2", stick_number: "ST-2", venue_id: "DD_2" })], screen_visits: {} }));
    await userEvent.click(await screen.findByRole("button", { name: "Log visit for screen 1" }));
    const form = screen.getByRole("group", { name: "Log visit for screen 1" });
    expect(screen.queryByRole("group", { name: "Log visit for screen 2" })).toBeNull(); // just that screen opens
    await userEvent.type(screen.getByLabelText("Dolphin Manager"), "Zoe");
    await userEvent.click(within(form).getByRole("radio", { name: "WiFi" }));
    expect(form.textContent).toContain("On the store's WiFi: ShopWiFi.");
    await fillLog(form);
    // Without Done or Incomplete nothing is sent.
    await userEvent.click(within(form).getByRole("button", { name: /Save log entry/ }));
    expect(within(form).getByRole("alert").textContent).toContain("Choose Done or Incomplete");
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);

    await userEvent.click(within(form).getByRole("checkbox", { name: "This screen is on a different WiFi" }));
    await userEvent.type(within(form).getByLabelText("WiFi name (SSID) for this screen"), "Back room");
    await userEvent.click(within(form).getByRole("radio", { name: "Incomplete" }));
    await userEvent.click(within(form).getByRole("button", { name: /Save log entry/ }));
    await waitFor(() => expect(api.calls.some((call) => call.method === "POST")).toBe(true));
    expect(api.calls.find((call) => call.method === "POST")!.body).toMatchObject({
      screen_id: "s1", dd_code: "DD_100", stick_number: "ST-1", installer: "Ann", dolphin_manager: "Zoe", visit_date: "2026-11-06",
      venue_name: "D_005_KIOSK", network_type: "WiFi", wifi_ssid: "Back room", latest_apk: true, kiosk_mode: false, dagent_installed: true,
      category: "Power Issues", subcategory: "TV Off", route_plan_id: "plan1", outcome: "incomplete",
    });
    expect(api.calls.some((call) => call.method === "PUT")).toBe(false); // the screen itself was not changed
    await waitFor(() => expect(screen.queryByRole("group", { name: "Log visit for screen 1" })).toBeNull()); // back to the lines
  });

  it("a change to the screen in its log (stick, DD code, mount) is saved to the store with the entry", async () => {
    const { api } = renderFromPlan(makeStop({ ...STOP, screens: [makeScreen({ id: "s1", stick_number: "ST-1", venue_id: "DD_1" }), makeScreen({ id: "s2", stick_number: "ST-2", venue_id: "DD_2" })], screen_visits: {} }));
    await userEvent.click(await screen.findByRole("button", { name: "Log visit for screen 2" }));
    const form = screen.getByRole("group", { name: "Log visit for screen 2" });
    const stick = within(form).getByLabelText("Stick #");
    await userEvent.clear(stick);
    await userEvent.type(stick, "ST-9");
    await userEvent.type(screen.getByLabelText("Dolphin Manager"), "Zoe");
    await userEvent.click(within(form).getByRole("radio", { name: "LTE" }));
    await fillLog(form);
    await userEvent.click(within(form).getByRole("radio", { name: "Done" }));
    await userEvent.click(within(form).getByRole("button", { name: /Save log entry/ }));
    await waitFor(() => expect(api.calls.some((call) => call.method === "POST")).toBe(true));
    const put = api.calls.find((call) => call.method === "PUT")!.body as { screens: { id: string; stick_number: string }[]; updated_by: string };
    expect(put.screens.map((row) => [row.id, row.stick_number])).toEqual([["s1", "ST-1"], ["s2", "ST-9"]]);
    expect(put.updated_by).toBe("Ann");
    expect(api.calls.find((call) => call.method === "POST")!.body).toMatchObject({ screen_id: "s2", stick_number: "ST-9", network_type: "LTE", wifi_ssid: "", outcome: "done" });
  });

  it("a Viewer sees the store and its history, with nothing to log or edit", async () => {
    renderFromPlan(STOP, [], "viewer");
    const lines = within(await screen.findByRole("list", { name: "Screens of this store" })).getAllByRole("listitem");
    expect(lines).toHaveLength(2);
    for (const name of [/Log visit/, /Add screen/, /Delete screen/, /Edit Store WiFi/]) expect(screen.queryByRole("button", { name }), String(name)).toBeNull();
    expect(screen.queryByRole("region", { name: "This visit" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Store comment" }).matches(":disabled")).toBe(true); // its group is off
    expect(screen.getByRole("complementary", { name: "Store details" })).toBeTruthy();
  });
});

