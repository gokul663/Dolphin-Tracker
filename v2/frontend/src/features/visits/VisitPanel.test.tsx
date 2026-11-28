import { todayIso } from "@/features/planner/planModel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { inventoryLine, signedInName, VisitPanel, type PlanStopActions } from "@/features/visits/VisitPanel";
import { mockApi, renderWithProviders } from "@/test/render";
import { makeKpi, makeProject, makeScreen, makeStop } from "@/test/fixtures";
import { STORE_FIELDS_FOR_TESTS } from "@/test/storeFields";
import type { Me, Role } from "@/lib/api/types";

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

const TODAY = todayIso(); // the local day, as the app uses (the UTC day differs in the evening)

/** Opened without a plan (the Log Visit page, the store window): the same store window, no plan chips or actions. */
function renderPanel({ stop = makeStop({ ...STOP, installer_name: "Ann" }), role = "super_admin" as Role, visits = [] as unknown[] } = {}) {
  const api = mockApi({
    "GET /api/projects/p1": () => ({ kpi: makeKpi(), ...makeProject() }),
    "GET /api/projects/p1/stores/u1": () => stop,
    "GET /api/config/store-fields": () => STORE_FIELDS_FOR_TESTS,
    "GET /api/config/maps": () => ({ google_maps_browser_key: "" }),
    "GET /api/lists/categories": () => [{ name: "Power Issues", subcategories: ["TV Off"] }],
    "GET /api/lists/installers": () => ({ items: [], next_cursor: null }),
    "GET /api/lists/managers": () => ({ items: [{ value: "Zoe", created_at: "" }], next_cursor: null }),
    "GET /api/projects/p1/stores/u1/visits": () => ({ items: visits, next_cursor: null }),
    "POST /api/projects/p1/stores/u1/visits": () => ({}),
    "GET /api/projects/p1/stores/u1/comments": () => ({ items: [], next_cursor: null }),
    "PUT /api/projects/p1/stores/u1/screens": (_url, init) => ({ ...stop, screens: (JSON.parse(String(init.body)) as { screens: unknown[] }).screens }),
    "PATCH /api/projects/p1/stores/u1": () => ({ ...stop, owner_name: "Sam Lee" }),
  });
  renderWithProviders(<VisitPanel projectId="p1" stopUid="u1" onClose={() => {}} />, { role });
  return api;
}

const barTabs = () => within(screen.getByRole("tablist", { name: "Screens of this store" })).getAllByRole("tab");

async function fillPlanless(form: HTMLElement) {
  await userEvent.click(within(form).getByRole("radio", { name: "LTE" }));
  await userEvent.click(within(within(form).getByRole("radiogroup", { name: "Latest APK" })).getByRole("radio", { name: "Yes" }));
  await userEvent.click(within(within(form).getByRole("radiogroup", { name: "Set Kiosk Mode" })).getByRole("radio", { name: "No" }));
  await userEvent.click(within(within(form).getByRole("radiogroup", { name: "Dagent installed" })).getByRole("radio", { name: "Yes" }));
  await userEvent.click(within(form).getByRole("combobox", { name: "Category" }));
  await userEvent.click(await screen.findByRole("option", { name: "Power Issues" }));
  await userEvent.click(within(form).getByRole("combobox", { name: "Subcategory" }));
  await userEvent.click(await screen.findByRole("option", { name: "TV Off" }));
  await userEvent.click(within(form).getByRole("radio", { name: "Done" }));
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear(); // the remembered Dolphin manager
});

describe("VisitPanel without a plan", () => {
  it("is the route planner's store window: the store's name, inventory, this visit, the screens bar and Details / Logs, and no plan chips or actions", async () => {
    renderPanel({ stop: makeStop({ ...STOP, installer_name: "Bo" }) });
    expect(await screen.findByRole("dialog", { name: "Alpha Mart" })).toBeTruthy();
    expect(screen.getByLabelText("Store status")).toBeTruthy();
    expect(screen.queryByLabelText("Stop in the plan")).toBeNull();
    expect(screen.queryByRole("group", { name: "Plan actions" })).toBeNull();
    expect(screen.getByRole("region", { name: "Inventory" })).toBeTruthy();
    const visit = screen.getByRole("region", { name: "This visit" });
    expect((within(visit).getByLabelText(/^Date/) as HTMLInputElement).value).toBe(TODAY);
    expect((within(visit).getByLabelText("Technician") as HTMLInputElement).value).toBe("Bo"); // the store's assigned installer
    expect(barTabs()).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "Details" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Logs/ })).toBeTruthy();
    expect(screen.getByText(/0 of 2 screens logged/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Submit Log Entry/ })).toBeNull(); // the old single form is gone
  });

  it("counts the screens logged on the visit's day, and saves a log entry with no route plan and no screens update", async () => {
    const api = renderPanel({ visits: [{ id: "v0", screen_id: "s1", visit_date: TODAY, outcome: "done", route_plan_id: "", category: "Power Issues", subcategory: "TV Off", installer: "Ann", dolphin_manager: "Zoe", network_type: "WiFi", stick_number: "ST-1", dd_code: "DD_1", created_at: `${TODAY}T08:00:00Z` }] });
    expect(await screen.findByText(/1 of 2 screens logged/)).toBeTruthy();
    const form = screen.getByRole("group", { name: "Log visit for screen 2" }); // the first not logged today
    await fillPlanless(form);
    await userEvent.click(within(form).getByRole("button", { name: /Save log entry/ }));
    await waitFor(() => expect(api.calls.some((call) => call.method === "POST")).toBe(true));
    expect(api.calls.find((call) => call.method === "POST")!.body).toMatchObject({ screen_id: "s2", route_plan_id: "", outcome: "done", visit_date: TODAY, dolphin_manager: "Test User" });
    expect(api.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("an Operator off a route sees the screen details read only with a note, and still saves the log entry", async () => {
    const api = renderPanel({ role: "operator" });
    const form = await screen.findByRole("group", { name: "Log visit for screen 1" });
    expect(within(form).getByText(/This store is not on a route: you can log the visit, and an admin can change its screen details/)).toBeTruthy();
    expect(within(form).getByLabelText("Stick #").matches(":disabled")).toBe(true);
    expect(within(form).getByRole("combobox", { name: "Status of screen 1" }).matches(":disabled")).toBe(true);
    expect(screen.queryByLabelText("Picture link for screen 1")).toBeNull(); // the Pictures card under the form
    for (const name of [/Add screen/, /Delete screen/, /Edit Store WiFi/]) expect(screen.queryByRole("button", { name }), String(name)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Store comment/ }));
    expect(screen.getByRole("textbox", { name: "Store comment" }).matches(":disabled")).toBe(true);
    // The log itself can be filled and saved.
    expect(within(form).getByRole("combobox", { name: "Category" }).matches(":disabled")).toBe(false);
    await fillPlanless(form);
    await userEvent.click(within(form).getByRole("button", { name: /Save log entry/ }));
    await waitFor(() => expect(api.calls.some((call) => call.method === "POST")).toBe(true));
    expect(api.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("an Operator on a route may change the screen details", async () => {
    renderPanel({ role: "operator", stop: makeStop({ ...STOP, route_plan_id: "plan1" }) });
    const form = await screen.findByRole("group", { name: "Log visit for screen 1" });
    expect(within(form).queryByText(/not on a route/)).toBeNull();
    expect(within(form).getByLabelText("Stick #").matches(":disabled")).toBe(false);
    expect(screen.getByLabelText("Picture link for screen 1")).toBeTruthy();
  });

  it("adds a picture to a screen and removes one after a confirm, saved with the screen; the thumbnails open large", async () => {
    const stop = makeStop({ ...STOP, screens: [makeScreen({ id: "s1", stick_number: "ST-1", venue_id: "DD_1", pictures: ["https://example.com/old.jpg"] }), makeScreen({ id: "s2", stick_number: "ST-2", venue_id: "DD_2" })] });
    const api = renderPanel({ stop });
    const form = await screen.findByRole("group", { name: "Log visit for screen 1" });
    // A card of its own under the form, not inside it.
    expect(within(form).queryByRole("group", { name: "Pictures of screen 1" })).toBeNull();
    const pictures = screen.getByRole("group", { name: "Pictures of screen 1" });
    expect(within(pictures).getAllByRole("listitem")).toHaveLength(1);
    await userEvent.type(within(pictures).getByLabelText("Picture link for screen 1"), "not a link");
    await userEvent.click(within(pictures).getByRole("button", { name: /Add picture/ }));
    expect(within(pictures).getByText(/starts with http/)).toBeTruthy();
    await userEvent.clear(within(pictures).getByLabelText("Picture link for screen 1"));
    await userEvent.type(within(pictures).getByLabelText("Picture link for screen 1"), "https://example.com/new.jpg");
    await userEvent.click(within(pictures).getByRole("button", { name: /Add picture/ }));
    expect(within(pictures).getAllByRole("listitem")).toHaveLength(2);
    expect(barTabs()[0]!.textContent).toContain("Unsaved input"); // part of the screen's draft
    await userEvent.click(within(pictures).getByRole("button", { name: "Remove picture 1 of screen 1" }));
    await userEvent.click(await screen.findByRole("button", { name: "Remove picture" }));
    expect(within(pictures).getAllByRole("listitem")).toHaveLength(1);
    await userEvent.click(within(pictures).getByRole("button", { name: "Show picture 1 of screen 1" }));
    expect(screen.getByRole("dialog", { name: "Picture of screen 1" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Close picture" }));
    await userEvent.click(within(form).getByRole("button", { name: /Save these details only/ }));
    await waitFor(() => expect(api.calls.some((call) => call.method === "PUT")).toBe(true));
    const put = api.calls.find((call) => call.method === "PUT")!.body as { screens: { id: string; pictures: string[] }[] };
    expect(put.screens.map((row) => [row.id, row.pictures])).toEqual([["s1", ["https://example.com/new.jpg"]], ["s2", []]]);
  });

  it("shows the store on one map under the form, the same whichever screen is picked", async () => {
    renderPanel();
    const map = await screen.findByRole("region", { name: "Store location" });
    expect(within(map).getByRole("link", { name: "Open in Google Maps" }).getAttribute("href")).toContain("query=33.75,-84.39");
    await userEvent.click(barTabs()[1]!);
    expect(screen.getAllByRole("region", { name: "Store location" })).toEqual([map]); // not drawn again per screen
  });

  it("says so quietly when the store has no map location", async () => {
    renderPanel({ stop: makeStop({ ...STOP, lat: null, lng: null }) });
    const map = await screen.findByRole("region", { name: "Store location" });
    expect(within(map).getByText("No map location")).toBeTruthy();
    expect(within(map).queryByRole("link")).toBeNull();
  });

  it("owner, store contact and WiFi each unlock with their own Edit, and saving updates the store", async () => {
    const api = renderPanel();
    // Read as text until Edit: no input to type into.
    expect((await screen.findByLabelText("Owner's Name")).tagName).toBe("DD");
    expect(screen.queryByRole("textbox", { name: "Owner's Name" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Store Contact Name" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Edit Owner" }));
    const owner = screen.getByRole("textbox", { name: "Owner's Name" }) as HTMLInputElement;
    expect(screen.queryByRole("textbox", { name: "Store Contact Name" })).toBeNull(); // only the owner group unlocks
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

  const STORE_ENTRY = { id: "c1", text: "Back door is locked after 6", visit_date: "2026-11-07", installer: "", dolphin_manager: "Zoe", route_plan_id: "plan1",
    project_id: "p1", stop_uid: "u1", created_by: "Test User", plan_name: "GA week", plan_day: 2, created_at: "2026-11-07T12:00:00Z" };

  function renderFromPlan(stop = STOP, visits: unknown[] = [], role: Role = "super_admin", { comments = [] as unknown[], actions, me }: { comments?: unknown[]; actions?: PlanStopActions; me?: Partial<Me> } = {}) {
    const api = mockApi({
      "GET /api/projects/p1": () => ({ kpi: makeKpi(), ...makeProject({ field_agent: "Fay" }) }),
      "GET /api/projects/p1/stores/u1": () => stop,
      "GET /api/config/store-fields": () => STORE_FIELDS_FOR_TESTS,
      "GET /api/lists/categories": () => [{ name: "Power Issues", subcategories: ["TV Off"] }],
      "GET /api/lists/installers": () => ({ items: [], next_cursor: null }),
      "GET /api/lists/managers": () => ({ items: [{ value: "Zoe", created_at: "" }], next_cursor: null }),
      "GET /api/projects/p1/stores/u1/visits": () => ({ items: visits, next_cursor: null }),
      "POST /api/projects/p1/stores/u1/visits": () => ({}),
      "GET /api/projects/p1/stores/u1/comments": () => ({ items: comments, next_cursor: null }),
      "POST /api/projects/p1/stores/u1/comments": () => ({ ...STORE_ENTRY, id: "c2" }),
      "PATCH /api/projects/p1/stores/u1/progress": () => stop,
      "PUT /api/projects/p1/stores/u1/screens": () => stop,
      "PATCH /api/projects/p1/stores/u1": () => stop,
      // The CMS data's record for DD_100 (the planner's all-venues list); other codes are not in it.
      "GET /api/projects/venues/stores/v-DD_100": () =>
        makeStop({ uid: "v-DD_100", store_name: "CMS Mart", pa: "ATM Boss", dma: "Macon", geocoded: "1 Elm St, Macon, GA 31201", screens: [makeScreen({ id: "v-DD_100-s1", venue_id: "DD_100", cms_name: "D_005_KIOSK", status: "Offline" })] }),
    });
    renderWithProviders(<VisitPanel projectId="p1" stopUid="u1" planId="plan1" installer="Ann" visitDate="2026-11-06" onClose={() => {}} plan={{ state: "route", actions }} />, { role, me });
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

  const tabs = () => within(screen.getByRole("tablist", { name: "Screens of this store" })).getAllByRole("tab");

  it("shows what to bring, the screens in a bar, and on the right who the store is, its WiFi and a summary of its logs", async () => {
    const stop = makeStop({
      ...STOP,
      venue_type: "Bar",
      wall_mounts_needed: null, wall_24_mounts_needed: null, ceiling_mounts_needed: 2, // typed earlier: not used
      screens: [
        makeScreen({ id: "s1", status: "Upcoming", screen_size: '43"', screen_type: "Dell", has_mount: true, venue_id: "DD_100", stick_number: "ST-1" }),
        makeScreen({ id: "s2", status: "Upcoming", screen_size: "", is_dolphin_screen: false, venue_id: "", stick_number: "" }),
        makeScreen({ id: "s3", status: "Completed", screen_size: '50"' }),
      ],
    });
    const { api } = renderFromPlan(stop, [PLAN_VISIT]);
    const inventory = await screen.findByRole("region", { name: "Inventory" });
    // Open by itself: there is something to bring.
    expect(within(inventory).getByRole("button", { name: /Inventory/ }).getAttribute("aria-expanded")).toBe("true");
    const need = within(inventory).getByRole("group", { name: "Needed" });
    expect(need.textContent).toContain("Sticks2"); // one per Upcoming screen
    expect(need.textContent).toContain('1 × 43" Dell');
    expect(need.textContent).toContain("1 × Wall"); // worked out from the Upcoming screen with a mount picked

    // The screens are tabs in the bar; the one logged in this plan says what it was left as.
    await waitFor(() => expect(tabs()[0]!.textContent).toContain("Done"));
    expect(tabs()).toHaveLength(3);
    expect(tabs()[0]!.textContent).toContain("Stick ST-1 · DD_100");
    expect(tabs()[1]!.textContent).toContain("No stick or DD code yet");
    expect(tabs()[1]!.textContent).toContain("Not logged");
    // It opens on the first screen not logged in this plan.
    await waitFor(() => expect(tabs()[1]!.getAttribute("aria-selected")).toBe("true"));
    expect(document.getElementById("screen-panel")!.textContent).toContain("Screen 2");
    expect(screen.getByText(/1 of 3 screens logged/)).toBeTruthy();
    expect(screen.queryByLabelText("PA")).toBeNull(); // nothing of PA / FA to fill in: they are on the right

    const side = screen.getByRole("complementary", { name: "Store details" });
    const identity = within(side).getByRole("region", { name: "Store" });
    await waitFor(() => expect(identity.textContent).toContain("from the CMS (DD_100)"));
    expect(identity.textContent).toContain("PAATM Boss");
    expect(identity.textContent).toContain("FAFay");
    expect(within(side).getByRole("group", { name: "Store WiFi" })).toBeTruthy();
    // The entries are under Logs, counted on its tab; Details shows first.
    await waitFor(() => expect(within(side).getByRole("tab", { name: /Logs/ }).textContent).toBe("Logs1"));
    expect(within(side).getByRole("tab", { name: "Details" }).getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("side-panel-logs")!.hidden).toBe(true); // the entries wait under Logs

    // The name is not edited here, and the venue type is the store's, shown with it (not on each screen).
    expect(within(side).queryByRole("button", { name: "Edit Store name" })).toBeNull();
    expect(identity.textContent).toContain("Venue typeBar");
    expect(within(screen.getByRole("group", { name: "Log visit for screen 2" })).queryByLabelText("Venue type")).toBeNull();
    expect(api.calls.some((call) => call.method === "PATCH")).toBe(false);

    // No store-level used boxes any more: those come from the screens. The store comment is folded away.
    expect(screen.queryByRole("group", { name: "Used at this store" })).toBeNull();
    expect(screen.queryByLabelText(/Screens used/)).toBeNull();
    expect(screen.queryByLabelText(/Mounts used/)).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Store comment" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Store comment/ }));
    expect(screen.getByRole("textbox", { name: "Store comment" })).toBeTruthy();
  });

  it("picking a screen in the bar shows its form, and what was typed in another survives the switch", async () => {
    renderFromPlan(makeStop({ ...STOP, screen_visits: {} }));
    await waitFor(() => expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true"));
    let form = screen.getByRole("group", { name: "Log visit for screen 1" });
    await userEvent.click(within(form).getByRole("radio", { name: "LTE" }));
    await userEvent.type(within(form).getByLabelText("Comments for this screen"), "cable loose");

    await userEvent.click(tabs()[1]!);
    expect(tabs()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("group", { name: "Log visit for screen 1" })).toBeNull(); // one form at a time
    form = screen.getByRole("group", { name: "Log visit for screen 2" });
    expect((within(form).getByLabelText("Comments for this screen") as HTMLTextAreaElement).value).toBe("");
    expect(within(form).getByRole("radio", { name: "LTE" }).getAttribute("aria-checked")).toBe("false");
    expect(tabs()[0]!.textContent).toContain("Unsaved input");

    // Arrow keys move along the bar too.
    await userEvent.keyboard("{ArrowUp}");
    expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true");
    form = screen.getByRole("group", { name: "Log visit for screen 1" });
    expect((within(form).getByLabelText("Comments for this screen") as HTMLTextAreaElement).value).toBe("cable loose");
    expect(within(form).getByRole("radio", { name: "LTE" }).getAttribute("aria-checked")).toBe("true");

    await userEvent.click(within(form).getByRole("button", { name: "Discard changes" }));
    expect((within(form).getByLabelText("Comments for this screen") as HTMLTextAreaElement).value).toBe("");
    expect(tabs()[0]!.textContent).not.toContain("Unsaved input");
  });

  it("Logs lists every entry of the store inline, newest first, the store's own labelled Store, and narrows to a screen or the store", async () => {
    const older = { ...PLAN_VISIT, id: "v0", visit_date: "2026-10-01", created_at: "2026-10-01T10:00:00Z", subcategory: "TV Off", comments: "first visit" };
    const other = { ...PLAN_VISIT, id: "v2", screen_id: "s2", stick_number: "ST-2", dd_code: "DD_2", visit_date: "2026-11-07", created_at: "2026-11-07T10:00:00Z", comments: "second screen" };
    const gone = { ...PLAN_VISIT, id: "v9", screen_id: "s9", stick_number: "ST-9", dd_code: "DD_9", visit_date: "2026-09-01", created_at: "2026-09-01T10:00:00Z", comments: "deleted screen" };
    renderFromPlan(makeStop({ ...STOP, screen_visits: {} }), [other, PLAN_VISIT, older, gone], "super_admin", { comments: [STORE_ENTRY] });
    const side = await screen.findByRole("complementary", { name: "Store details" });
    const logsTab = within(side).getByRole("tab", { name: /Logs/ });
    await waitFor(() => expect(logsTab.textContent).toBe("Logs5"));

    // What is typed in the form stays while the column switches.
    const form = screen.getByRole("group", { name: "Log visit for screen 1" });
    await userEvent.type(within(form).getByLabelText("Comments for this screen"), "cable loose");
    await userEvent.click(logsTab);
    expect(logsTab.getAttribute("aria-selected")).toBe("true");
    const logs = within(side).getByRole("tabpanel", { name: /Logs/ });
    expect(document.getElementById("side-panel-details")!.hidden).toBe(true);
    expect(logs.textContent).toContain("5 log entries · last 2026-11-07");
    const entries = () => within(logs).getAllByRole("listitem").map((item) => item.textContent ?? "");
    expect(entries()).toHaveLength(5);
    expect(entries()[0]).toContain("Back door is locked after 6"); // the store's own, newest (12:00 on 11-07)
    expect(entries()[0]).toContain("Store");
    expect(entries()[0]).toContain("managed by Zoe");
    expect(entries()[0]).toContain("GA week · day 2");
    expect(entries()[1]).toContain("second screen");
    expect(entries()[4]).toContain("Removed stick"); // a deleted screen's entry still shows under All screens

    await userEvent.click(within(logs).getByRole("combobox", { name: "Filter by screen" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["All screens", "Store", "Stick ST-1 · DD_1", "Stick ST-2 · DD_2"]);
    await userEvent.click(screen.getByRole("option", { name: "Store" }));
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toContain("Back door is locked after 6");
    await userEvent.click(within(logs).getByRole("combobox", { name: "Filter by screen" }));
    await userEvent.click(screen.getByRole("option", { name: "Stick ST-1 · DD_1" }));
    expect(entries()).toHaveLength(2);
    expect(entries().every((text) => text.includes("ST-1"))).toBe(true);

    await userEvent.click(within(side).getByRole("tab", { name: "Details" }));
    expect(form.isConnected).toBe(true); // the form was never unmounted
    expect((within(form).getByLabelText("Comments for this screen") as HTMLTextAreaElement).value).toBe("cable loose");
  });

  it("saving a store comment logs it as an entry of its own and keeps it as the store's comment", async () => {
    const { api } = renderFromPlan(makeStop({ ...STOP, comment: "Old note" }), [], "super_admin", { me: { name: "Dana Reyes" } });
    await userEvent.click(await screen.findByRole("button", { name: /Store comment/ }));
    const box = screen.getByRole("textbox", { name: "Store comment" }) as HTMLTextAreaElement;
    expect(box.value).toBe("Old note"); // the current comment, though it has no entry
    await userEvent.clear(box);
    await userEvent.type(box, "Gate code 1234");
    await userEvent.click(screen.getByRole("button", { name: "Save comment" }));
    await waitFor(() => expect(api.calls.some((call) => call.method === "POST" && call.url.pathname.endsWith("/comments"))).toBe(true));
    expect(api.calls.find((call) => call.method === "POST")!.body).toEqual({
      text: "Gate code 1234", visit_date: "2026-11-06", installer: "Ann", dolphin_manager: "Dana Reyes", route_plan_id: "plan1",
    });
    // One call: the server sets the store's comment with the entry. Nothing is logged against a screen.
    expect(api.calls.some((call) => call.method === "PATCH" || call.url.pathname.endsWith("/visits") && call.method === "POST")).toBe(false);

    // Emptying the box clears the store's comment, with no entry.
    await userEvent.clear(box);
    await userEvent.click(screen.getByRole("button", { name: "Save comment" }));
    await waitFor(() => expect(api.calls.some((call) => call.method === "PATCH")).toBe(true));
    expect(api.calls.find((call) => call.method === "PATCH")!.body).toEqual({ comment: "" });
    expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("the header has the stop's chips by the name and its plan actions, each calling the planner", async () => {
    const actions = { byVisits: false, hasVisit: false, pinned: true, removed: false, onMove: vi.fn(), onMark: vi.fn(), onUnpin: vi.fn(), onSetAside: vi.fn(), onRemove: vi.fn() };
    renderFromPlan(STOP, [PLAN_VISIT], "super_admin", { actions });
    const header = (await screen.findByRole("heading", { name: "Alpha Mart" })).parentElement!;
    expect(within(header).getByRole("combobox", { name: "Stop in the plan" }).textContent).toBe("In route");
    expect(within(header).getByLabelText("Store status").textContent).toBe("Upcoming");
    expect(within(header).getByText("Kept on this day")).toBeTruthy();
    await waitFor(() => expect(header.textContent).toContain("1 of 2 screens logged"));
    expect(screen.queryByText(/the stop is Done when/)).toBeNull(); // a tooltip now, not a line

    const group = screen.getByRole("group", { name: "Plan actions" });
    await userEvent.click(within(group).getByRole("button", { name: /Move/ }));
    await userEvent.click(within(group).getByRole("button", { name: /Remove from day/ }));
    await userEvent.click(within(group).getByRole("button", { name: /Remove from plan/ }));
    await userEvent.click(within(header).getByRole("button", { name: "Let it be recalculated again" }));
    expect([actions.onMove, actions.onSetAside, actions.onRemove, actions.onUnpin].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1, 1]);
    await userEvent.click(within(header).getByRole("combobox", { name: "Stop in the plan" }));
    await userEvent.click(await screen.findByRole("option", { name: "Incomplete" }));
    expect(actions.onMark).toHaveBeenCalledWith("incomplete");
  });

  it("shows no plan action without its handler or the permission the day card asks for", async () => {
    const all = { byVisits: false, hasVisit: false, pinned: true, removed: false, onMove: vi.fn(), onMark: vi.fn(), onUnpin: vi.fn(), onSetAside: vi.fn(), onRemove: vi.fn() };
    renderFromPlan(STOP, [], "viewer", { actions: all });
    await screen.findByRole("heading", { name: "Alpha Mart" });
    expect(screen.queryByRole("group", { name: "Plan actions" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Stop in the plan" })).toBeNull();
    expect(screen.getByLabelText("Stop in the plan").textContent).toContain("In route");
    expect(screen.queryByRole("button", { name: "Let it be recalculated again" })).toBeNull();
  });

  it("an Operator moves and takes a stop off its day, but not out of the plan", async () => {
    const some = { byVisits: true, hasVisit: true, pinned: false, removed: false, onMove: vi.fn(), onSetAside: vi.fn(), onRemove: vi.fn() };
    renderFromPlan(STOP, [], "operator", { actions: some });
    const group = await screen.findByRole("group", { name: "Plan actions" });
    expect(within(group).getByRole("button", { name: /Move/ })).toBeTruthy();
    expect(within(group).getByRole("button", { name: /Remove from day/ }).matches(":disabled")).toBe(true); // a visit is logged
    expect(within(group).queryByRole("button", { name: /Remove from plan/ })).toBeNull(); // routes.manage only
    expect(screen.queryByRole("combobox", { name: "Stop in the plan" })).toBeNull(); // Done by its visits, not by hand
  });

  it("a stop without the planner's handlers shows its chips and no actions", async () => {
    renderFromPlan(STOP, [], "super_admin", { actions: { byVisits: false, hasVisit: false, pinned: false, removed: false } });
    await screen.findByRole("heading", { name: "Alpha Mart" });
    expect(screen.queryByRole("group", { name: "Plan actions" })).toBeNull();
    expect(screen.getByLabelText("Stop in the plan").textContent).toContain("In route");
  });

  it("starts the Dolphin manager as the signed-in person's name, else the remembered one, else empty", async () => {
    expect(signedInName({ id: "u1", name: " Dana Reyes " })).toBe("Dana Reyes");
    expect(signedInName({ id: "u1", name: "dana@dolphin.com" })).toBe(""); // never an email
    expect(signedInName({ id: "local", name: "Local user" })).toBe(""); // sign-in off: no one's name
    expect(signedInName(undefined)).toBe("");

    window.localStorage.setItem("dolphin-tracker.last-manager", "Zoe");
    renderFromPlan(STOP, [], "super_admin", { me: { name: "Dana Reyes" } });
    expect(((await screen.findByLabelText("Dolphin Manager")) as HTMLInputElement).value).toBe("Dana Reyes");
  });

  it("falls back to the remembered manager when sign-in is off", async () => {
    window.localStorage.setItem("dolphin-tracker.last-manager", "Zoe");
    renderFromPlan(STOP, [], "super_admin", { me: { id: "local", name: "Local user" } });
    expect(((await screen.findByLabelText("Dolphin Manager")) as HTMLInputElement).value).toBe("Zoe");
  });

  it("the inventory folds to one line of totals; with nothing to bring it starts folded, and Used counts the installed screens", async () => {
    const installed = makeStop({
      ...STOP,
      status: "Completed",
      screens: [
        makeScreen({ id: "s1", status: "Completed", screen_size: '24"', has_mount: true }),
        makeScreen({ id: "s2", status: "Offline", screen_size: '50"', has_mount: true, has_ceiling_mount: true }),
        makeScreen({ id: "s3", status: "Completed", is_dolphin_screen: false }),
      ],
    });
    expect(inventoryLine(installed)).toBe("Needed: nothing to install — Used: 2 screens · 1 store TV · 2 mounts");
    expect(inventoryLine(makeStop({ ...STOP, screens: [makeScreen({ id: "s1", screen_size: '24"' })] }))).toBe("Needed: 1 stick · 1 screen · 0 mounts — Used: 0 screens · 0 mounts");

    renderFromPlan(installed);
    const inventory = await screen.findByRole("region", { name: "Inventory" });
    const toggle = within(inventory).getByRole("button", { name: /Inventory/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("Used: 2 screens · 1 store TV · 2 mounts");
    await userEvent.click(toggle);
    const used = within(inventory).getByRole("group", { name: "Used" });
    expect(used.textContent).toContain("Screens2");
    expect(used.textContent).toContain('1 × Wall 24"');
    expect(used.textContent).toContain("1 × Ceiling");
    expect(within(inventory).getByRole("group", { name: "Needed" }).textContent).toContain("Nothing");
  });

  it("logs one screen from the bar: network, software, issue, Done or Incomplete; the store's WiFi unless another is ticked", async () => {
    const { api } = renderFromPlan(makeStop({ ...STOP, screens: [makeScreen({ id: "s1", status: "Offline", stick_number: "ST-1", venue_id: "DD_100" }), makeScreen({ id: "s2", stick_number: "ST-2", venue_id: "DD_2" })], screen_visits: {} }));
    await screen.findByRole("tablist", { name: "Screens of this store" });
    await userEvent.click(tabs()[0]!);
    const form = screen.getByRole("group", { name: "Log visit for screen 1" });
    expect(screen.queryByRole("group", { name: "Log visit for screen 2" })).toBeNull(); // just that screen opens
    await userEvent.clear(screen.getByLabelText("Dolphin Manager"));
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
    // On to the next screen not logged yet.
    expect(await screen.findByRole("group", { name: "Log visit for screen 2" })).toBeTruthy();
  });

  it("a change to the screen in its log (stick, DD code, mount) is saved to the store with the entry", async () => {
    const { api } = renderFromPlan(makeStop({ ...STOP, screens: [makeScreen({ id: "s1", stick_number: "ST-1", venue_id: "DD_1" }), makeScreen({ id: "s2", stick_number: "ST-2", venue_id: "DD_2" })], screen_visits: {} }));
    await screen.findByRole("tablist", { name: "Screens of this store" });
    await userEvent.click(tabs()[1]!);
    const form = screen.getByRole("group", { name: "Log visit for screen 2" });
    const stick = within(form).getByLabelText("Stick #");
    await userEvent.clear(stick);
    await userEvent.type(stick, "ST-9");
    await userEvent.clear(screen.getByLabelText("Dolphin Manager"));
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

  it("adds a screen from the bar, and deletes one from its form after a confirm", async () => {
    const { api } = renderFromPlan(makeStop({ ...STOP, screen_visits: {} }));
    await screen.findByRole("tablist", { name: "Screens of this store" });
    await userEvent.click(screen.getByRole("button", { name: /Add screen/ }));
    expect(tabs()).toHaveLength(3);
    expect(tabs()[2]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs()[2]!.textContent).toContain("New, not saved");
    await userEvent.click(within(screen.getByRole("group", { name: "Log visit for screen 3" })).getByRole("button", { name: "Cancel" }));
    expect(tabs()).toHaveLength(2);

    await userEvent.click(tabs()[1]!);
    await userEvent.click(screen.getByRole("button", { name: "Delete screen 2" }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete screen" }));
    await waitFor(() => expect(api.calls.some((call) => call.method === "PUT")).toBe(true));
    const put = api.calls.find((call) => call.method === "PUT")!.body as { screens: { id: string }[] };
    expect(put.screens.map((row) => row.id)).toEqual(["s1"]);
  });

  it("a Viewer sees the store, its screens and logs, with nothing to log or edit", async () => {
    renderFromPlan(STOP, [], "viewer");
    await screen.findByRole("tablist", { name: "Screens of this store" });
    expect(tabs()).toHaveLength(2);
    await userEvent.click(tabs()[0]!);
    const form = screen.getByRole("group", { name: "Log visit for screen 1" });
    for (const name of [/Save log entry/, /Add screen/, /Delete screen/, /Edit Store WiFi/, /Discard/]) expect(screen.queryByRole("button", { name }), String(name)).toBeNull();
    expect(within(form).getByRole("combobox", { name: "Category" }).matches(":disabled")).toBe(true);
    expect(screen.queryByRole("region", { name: "This visit" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Store comment/ }));
    expect(screen.getByRole("textbox", { name: "Store comment" }).matches(":disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Save comment" })).toBeNull();
    expect(screen.getByRole("tab", { name: /Logs/ })).toBeTruthy();
  });
});
