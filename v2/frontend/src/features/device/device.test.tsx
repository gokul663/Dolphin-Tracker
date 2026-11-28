import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { ProjectPage } from "@/features/projects/ProjectPage";
import { SettingsTab } from "@/features/settings/SettingsTab";
import { ReviewDialog } from "@/features/device/ReviewDialog";
import { StoreDeviceSection } from "@/features/device/StoreDeviceSection";
import { jsonError, mockApi, renderWithProviders } from "@/test/render";
import { makeProject, makeScreen, makeStop, makeSummary } from "@/test/fixtures";
import type { DeviceSyncState, ReviewItem } from "@/lib/api/types";

const STATE: DeviceSyncState = {
  pa: "IBC", snapshot_date: "2026-11-09", ingested_at: "2026-11-10T03:02:06+00:00", synced_at: "2026-11-10T12:00:00+00:00",
  matched_screens: 2, status_changes: 1, review_count: 1, not_reporting: 0, other_pa_count: 0,
};

const ITEM: ReviewItem = {
  venue_id: "DD_NEW001", date: "2026-11-09", status: "Online", last_seen: "", offline_days: 0, serial_number: "SN1",
  venue_name: "CMS_NEW", store_name: "New Gas", address: "1 Elm St, Kalamazoo, MI 49009", addr: "1 Elm St",
  city: "Kalamazoo", state: "MI", zip: "49009", lat: 42.2, lng: -85.6, pa_name: "IBC", external_id: "", dma: "", venue_type: "", first_registered: "", last_registered: "", key: "DD_NEW001",
  snoozed_date: "",
};

function renderProject(tab = "settings") {
  return renderWithProviders(
    <Routes>
      <Route path="projects/:projectId" element={<ProjectPage />}>
        <Route path="settings" element={<SettingsTab />} />
        <Route path="stores" element={<div>stores tab</div>} />
      </Route>
    </Routes>,
    { path: "/*", route: `/projects/p1/${tab}` },
  );
}

describe("Device sync in the project", () => {
  it("syncs on open when a PA is chosen and shows Needs review", async () => {
    const { calls } = mockApi({
      "GET /api/projects/p1": () => makeSummary({ device_pa: "IBC", device_sync: STATE }),
      "POST /api/projects/p1/device-sync": () => ({ synced: false, state: STATE, stores_updated: 0 }),
      "GET /api/projects/p1/device-sync/review": () => ({ items: [ITEM], next_cursor: null, total: 1, snoozed: 0 }),
    });
    renderProject("stores");
    const chip = await screen.findByRole("button", { name: "1 screens need review" });
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST" && call.url.pathname === "/api/projects/p1/device-sync")?.url.searchParams.get("only_if_stale")).toBe("true"),
    );
    await userEvent.click(chip);
    expect(await screen.findByText("New Gas")).toBeTruthy();
  });

  it("does not sync a project without a PA", async () => {
    const { calls } = mockApi({ "GET /api/projects/p1": () => makeSummary() });
    renderProject("stores");
    await screen.findByText("stores tab");
    expect(calls.some((call) => call.url.pathname.endsWith("/device-sync"))).toBe(false);
    // Nothing to review: the bubble keeps its place, at 0 and inert.
    expect((screen.getByRole("button", { name: "0 screens need review" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Settings saves the PA and syncs", async () => {
    const { calls } = mockApi({
      "GET /api/projects/p1": () => makeSummary(),
      "GET /api/device-data/pas": () => ({ date: "2026-11-09", pas: ["IBC", "VTA PA"] }),
      "PATCH /api/projects/p1": () => makeProject({ device_pa: "IBC", version: 2 }),
      "POST /api/projects/p1/device-sync": () => ({ synced: true, state: STATE, stores_updated: 2 }),
    });
    renderProject();
    const input = await screen.findByLabelText("Sync with PA");
    await userEvent.type(input, "IBC");
    await userEvent.click(screen.getByRole("button", { name: "Save and sync" }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.url.pathname === "/api/projects/p1/device-sync")).toBe(true));
    expect(calls.find((call) => call.method === "PATCH")?.body).toMatchObject({ device_pa: "IBC", expected_version: 1 });
  });
});

describe("Needs review", () => {
  it("adds a record as a store and sets one aside with Not now", async () => {
    const { calls } = mockApi({
      "GET /api/projects/p1/device-sync/review": () => ({ items: [ITEM], next_cursor: null, total: 1, snoozed: 2 }),
      "POST /api/projects/p1/device-sync/review/DD_NEW001/add": () => makeStop({ store_name: "New Gas" }),
      "POST /api/projects/p1/device-sync/review/DD_NEW001/snooze": () => ({ ...ITEM, snoozed_date: "2026-11-09" }),
    });
    renderWithProviders(<ReviewDialog project={makeProject({ device_pa: "IBC", device_sync: STATE })} open onClose={() => {}} />);
    expect(await screen.findByText(/Show the ones set to Not now \(2\)/)).toBeTruthy();
    const row = (await screen.findByText("New Gas")).closest("li") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "Not now" }));
    await userEvent.click(within(row).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(calls.some((call) => call.url.pathname.endsWith("/DD_NEW001/add"))).toBe(true));
    expect(calls.some((call) => call.url.pathname.endsWith("/DD_NEW001/snooze"))).toBe(true);
  });
});

describe("Needs review: several at once", () => {
  it("ticks rows and adds them together; one Google cannot verify opens its address step and is no longer counted", async () => {
    const second = { ...ITEM, venue_id: "DD_NEW002", key: "DD_NEW002", store_name: "Second Stop", dma: "Detroit", last_registered: "2026-10-02T10:00:00+00:00" };
    const { calls } = mockApi({
      "GET /api/projects/p1/device-sync/review": () => ({ items: [ITEM, second], next_cursor: null, total: 2, snoozed: 0 }),
      "POST /api/projects/p1/device-sync/review/DD_NEW001/add": () => makeStop({ store_name: "New Gas" }),
      "POST /api/projects/p1/device-sync/review/DD_NEW002/add": () => jsonError(422, { message: "Google could not verify this address.", suggestions: [], address: "" }),
    });
    renderWithProviders(<ReviewDialog project={makeProject({ device_pa: "IBC", device_sync: STATE })} open onClose={() => {}} />);
    // Each row spells out what the report knows, under its name.
    const facts = await screen.findByLabelText("Details of DD_NEW002");
    expect(facts.textContent).toContain("DMADetroit");
    expect(facts.textContent).toContain("Registered2026-10-02");
    expect(screen.getByLabelText("Details of DD_NEW001").textContent).toContain("RegisteredNever");
    expect(screen.queryByRole("button", { name: /selected/ })).toBeNull(); // nothing ticked yet
    await userEvent.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
    await userEvent.click(screen.getByRole("button", { name: "Add 2 selected" }));
    await waitFor(() => expect(calls.filter((call) => call.url.pathname.endsWith("/add"))).toHaveLength(2));
    expect(await screen.findByText("Google could not verify this address.")).toBeTruthy();
    // Nothing was fixed, so nothing is left to add: no "Add 1 selected" that would only fail again.
    await waitFor(() => expect(screen.queryByRole("button", { name: /Add \d+ selected/ })).toBeNull());
    const failed = screen.getByRole("checkbox", { name: "Select DD_NEW002" });
    expect(failed.getAttribute("aria-checked")).toBe("false");
    expect(failed.hasAttribute("disabled")).toBe(true); // it is dealt with in its address step
    // Select all skips it too.
    await userEvent.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
    expect(screen.getByRole("button", { name: "Add 1 selected" })).toBeTruthy(); // DD_NEW001 only (still listed here)
    expect(calls.filter((call) => call.url.pathname.endsWith("/DD_NEW002/add"))).toHaveLength(1);
  });
});

describe("Needs review: the address check", () => {
  it("asks for an address Google can verify, then checks it or adds anyway", async () => {
    const noAddress = { ...ITEM, address: "", addr: "", city: "", state: "", zip: "", lat: null, lng: null, store_name: "LA22 Mart- Ponchatoula" };
    const sent: Record<string, unknown>[] = [];
    mockApi({
      "GET /api/projects/p1/device-sync/review": () => ({ items: [noAddress], next_cursor: null, total: 1, snoozed: 0 }),
      "POST /api/projects/p1/device-sync/review/DD_NEW001/add": (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        sent.push(body);
        if (body.add_anyway || body.address === "500 Rail Rd, Ponchatoula, LA 70454") return makeStop({ store_name: "LA22 Mart" });
        return jsonError(422, {
          message: body.address ? "Google could not verify this address. Pick a suggestion, search Google, or add it anyway." : "The report has no address for this store. Enter one, search Google, or add it anyway.",
          suggestions: body.address ? ["500 Rail Rd, Ponchatoula, LA 70454"] : [],
          address: String(body.address ?? ""),
        });
      },
    });
    renderWithProviders(<ReviewDialog project={makeProject({ device_pa: "IBC", device_sync: STATE })} open onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Add" }));
    expect(await screen.findByText(/The report has no address for this store/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Search Google for DD_NEW001" })).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Address for DD_NEW001"), "500 Rail");
    await userEvent.click(screen.getByRole("button", { name: "Check address" }));
    await userEvent.click(await screen.findByRole("button", { name: "500 Rail Rd, Ponchatoula, LA 70454" }));
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent).toEqual([{}, { address: "500 Rail" }, { address: "500 Rail Rd, Ponchatoula, LA 70454" }]);
  });
});

describe("Store drawer: Dolphin data", () => {
  const device = { store_name: "Report Name", venue_name: "CMS_A", address: "", addr: "9 Oak St", city: "Atlanta", state: "GA",
    zip: "30303", lat: 33.8, lng: -84.3, dma: "Atlanta", venue_type: "Convenience Store", date: "2026-11-09" };

  it("shows the report values over the sheet's and overwrites one field", async () => {
    const { calls } = mockApi({ "POST /api/projects/p1/stores/u1/device-overwrite": () => ({ stores_updated: 1 }) });
    renderWithProviders(<StoreDeviceSection project={makeProject({ device_sync: STATE })} stop={makeStop({ device })} />);
    const row = screen.getByText("Store name").closest("tr") as HTMLElement;
    expect(within(row).getByText("Alpha Mart")).toBeTruthy();
    expect(within(row).getByText("Report Name")).toBeTruthy();
    await userEvent.click(within(row).getByRole("button", { name: "Overwrite" }));
    await waitFor(() => expect(calls[0]?.body).toEqual({ fields: ["store_name"] }));
    // City, state and ZIP match the sheet: nothing to overwrite there.
    expect(within(screen.getByText("City").closest("tr") as HTMLElement).queryByRole("button")).toBeNull();
    expect(screen.getByRole("button", { name: /Overwrite all \(5\)/ })).toBeTruthy(); // name, address, DMA, venue type, location
  });

  it("explains 'not in Dolphin data' and ignores it until the next report", async () => {
    const { calls } = mockApi({ "POST /api/projects/p1/stores/u1/device-alert/ignore": () => makeStop() });
    const stop = makeStop({ status: "Completed", needs_attention: ["not_reporting"],
      screens: [makeScreen({ id: "s1", venue_id: "DD-GONE01", status: "Completed" })] });
    renderWithProviders(<StoreDeviceSection project={makeProject({ device_sync: STATE })} stop={stop} />);
    expect(screen.getByRole("alert").textContent).toContain("DD-GONE01 is not in the Dolphin data of 11-09");
    await userEvent.click(screen.getByRole("button", { name: "Ignore until the next report" }));
    await waitFor(() => expect(calls.some((call) => call.url.pathname.endsWith("/device-alert/ignore"))).toBe(true));
  });

  it("once the sheet matches the Dolphin data, the section stays out of the way (the header says synced)", () => {
    mockApi({});
    const synced = makeStop({
      device, store_name: device.store_name, addr: device.addr, city: device.city, state: device.state, zip: device.zip,
      lat: device.lat, lng: device.lng, dma: device.dma, venue_type: device.venue_type,
    });
    const { container } = renderWithProviders(<StoreDeviceSection project={makeProject({ device_sync: STATE })} stop={synced} />);
    expect(container.querySelector("section")).toBeNull();
  });


  it("shows nothing for a store without Dolphin data or alerts", () => {
    mockApi({});
    const { container } = renderWithProviders(<StoreDeviceSection project={makeProject()} stop={makeStop()} />);
    expect(container.querySelector("section")).toBeNull();
  });
});

describe("Several DD codes in one entry", () => {
  it("splits codes like the server", async () => {
    const { splitCodes } = await import("@/features/device/DeviceBits");
    expect(splitCodes("DD-HJGK7Z. DD-HB8P6I")).toEqual(["DD-HJGK7Z", "DD-HB8P6I"]);
    expect(splitCodes("DD - ABC123")).toEqual(["DD - ABC123"]);
    expect(splitCodes("DD-HFN64S.")).toEqual(["DD-HFN64S"]);
  });

  it("suggests a split and applies it only when asked", async () => {
    const { draftScreens } = await import("@/test/screens");
    mockApi({});
    const stop = makeStop({ screens: [makeScreen({ id: "s1", venue_id: "DD-HJGK7Z. DD-HB8P6I", stick_number: "DD-002-02969. DD-002-01380", status: "Completed" })] });
    const draft = draftScreens(makeProject(), stop);
    renderWithProviders(draft.element);
    expect(screen.getByRole("alert").textContent).toContain("DD-HJGK7Z (stick DD-002-02969); DD-HB8P6I (stick DD-002-01380)");
    expect(screen.getAllByRole("listitem")).toHaveLength(1); // nothing changes until Split is pressed
    await userEvent.click(screen.getByRole("button", { name: "Split into 2 screens" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(draft.latest().map((row) => [row.id, row.venue_id, row.stick_number, row.status])).toEqual([
      ["s1", "DD-HJGK7Z", "DD-002-02969", "Completed"],
      [undefined, "DD-HB8P6I", "DD-002-01380", "Completed"],
    ]);
  });
});

describe("A store added without an ExtID", () => {
  it("asks for the ExtID in the store and saves it once", async () => {
    const { StoreDrawer } = await import("@/features/stores/StoreDrawer");
    const { STORE_FIELDS_FOR_TESTS } = await import("@/test/storeFields");
    const stop = makeStop({ external_id: "", needs_attention: ["external_id"] });
    const { calls } = mockApi({
      "GET /api/projects/p1/stores/u1": () => stop,
      "GET /api/config/store-fields": () => STORE_FIELDS_FOR_TESTS,
      "GET /api/route-plans": () => ({ items: [], next_cursor: null }),
      "GET /api/projects/p1/stores/u1/visits": () => ({ items: [], next_cursor: null }),
      "PUT /api/projects/p1/stores/u1/external-id": () => ({ ...stop, external_id: "LA70454", needs_attention: [] }),
    });
    renderWithProviders(<StoreDrawer project={makeProject()} stopId="u1" open onClose={() => {}} />);
    const input = await screen.findByLabelText(/ExtID \(missing\)/);
    await userEvent.type(input, "la70454");
    await userEvent.click(within(input.closest("form") as HTMLElement).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ external_id: "LA70454" }));
  });
});
