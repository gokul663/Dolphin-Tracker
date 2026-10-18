import { Profiler } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { ProjectPage } from "@/features/projects/ProjectPage";
import { StoresTab } from "@/features/stores/StoresTab";
import { jsonError, mockApi, renderWithProviders } from "@/test/render";
import { makeProject, makeStop } from "@/test/fixtures";
import { useStoresUi } from "@/stores/ui";
import { keys } from "@/lib/api/keys";
import { deriveStatus, type ScreenInput, type Stop } from "@/lib/api/types";
import { STORE_FIELDS_FOR_TESTS } from "@/test/storeFields";

const STOPS: Stop[] = [
  makeStop({ pa: "", committed_dolphin_screens: 2 }),
  makeStop({
    uid: "u2", display_id: "S2", external_id: "IBC-2", store_name: "Beta Deli", addr: "2 Oak St", city: "Decatur",
    status: "Completed", installer: "Bo", lat: 33.8, pa: "South",
  }),
];

/** A tiny stateful fake: successful PATCHes change what later GETs return, like the real API. */
function renderTab(routes: Parameters<typeof mockApi>[0] = {}, onRender?: () => void) {
  const db = new Map(STOPS.map((stop) => [stop.uid, { ...stop }]));
  const write = (uid: string, init: RequestInit) => {
    const current = db.get(uid) as Stop;
    const body = JSON.parse(String(init.body)) as Partial<Stop>;
    const next = { ...current, ...body, fields: { ...current.fields, ...(body.fields ?? {}) } };
    db.set(uid, next);
    return next;
  };
  const api = mockApi({
    "GET /api/projects/p1": () => makeProject(),
    "GET /api/projects/p1/stores": () => ({ items: [...db.values()], next_cursor: null }),
    "GET /api/projects/p1/stores/pins": () =>
      [...db.values()].map(({ uid, lat, lng, status, store_name, installer, day }) => ({ uid, lat, lng, status, store_name, installer, day })),
    "GET /api/config/maps": () => ({ google_maps_browser_key: "" }),
    "GET /api/projects/p1/stores/u1": () => db.get("u1"),
    "PATCH /api/projects/p1/stores/u1": (_url, init) => write("u1", init),
    "PATCH /api/projects/p1/stores/u1/progress": (_url, init) => write("u1", init),
    "PUT /api/projects/p1/stores/u1/screens": (_url, init) => {
      const { screens } = JSON.parse(String(init.body)) as { screens: ScreenInput[] };
      const rows = screens.map((screen, index) => ({ ...screen, id: screen.id ?? `minted-${index}` })) as Stop["screens"];
      const next = { ...(db.get("u1") as Stop), screens: rows, status: deriveStatus(rows.map((row) => row.status)) };
      db.set("u1", next);
      return next;
    },
    "GET /api/config/store-fields": () => STORE_FIELDS_FOR_TESTS,
    ...routes,
  });
  const { client } = renderWithProviders(
    <Routes>
      <Route path="projects/:projectId" element={<ProjectPage />}>
        <Route path="stores" element={<Profiler id="stores" onRender={() => onRender?.()}><StoresTab /></Profiler>} />
      </Route>
    </Routes>,
    { path: "/*", route: "/projects/p1/stores" },
  );
  return { ...api, client, db };
}

/** Clicking the store name edits it inline; any other part of the row opens the drawer. */
async function openDrawer() {
  await userEvent.click(await screen.findByText("IBC-1"));
  return screen.findByRole("dialog");
}

const lastList = (calls: ReturnType<typeof mockApi>["calls"]) =>
  [...calls].reverse().find((call) => call.method === "GET" && call.url.pathname === "/api/projects/p1/stores")?.url;

// jsdom lays nothing out: every element measures 0 px, so the virtualizer (which sizes its viewport from
// clientWidth/clientHeight) would render no rows. Give elements a size for this file only.
const sized = { clientHeight: 640, clientWidth: 1200 } as const;
const originals = Object.keys(sized).map((key) => [key, Object.getOwnPropertyDescriptor(Element.prototype, key)] as const);
beforeAll(() => {
  for (const [key, value] of Object.entries(sized)) {
    Object.defineProperty(Element.prototype, key, { configurable: true, get: () => value });
  }
});
afterAll(() => {
  for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(Element.prototype, key, descriptor);
});

describe("StoresTab", () => {
  beforeEach(() => useStoresUi.setState({ projectId: null }));

  it("does not re-render on map bounds unless 'only stores in view' is on", async () => {
    let renders = 0;
    renderTab({}, () => (renders += 1));
    expect(await screen.findByText("Alpha Mart")).toBeTruthy();
    const settled = renders;
    const pan = (north: number) => act(() => useStoresUi.getState().setBounds({ north, south: 33, east: -84, west: -85 }));
    pan(34);
    pan(34.1);
    expect(renders).toBe(settled); // panning with the filter off: no tab render at all

    act(() => useStoresUi.getState().setOnlyInView(true));
    const withFilter = renders;
    pan(33.75); // only Alpha (33.7) is inside now
    expect(renders).toBeGreaterThan(withFilter);
    await waitFor(() => expect(screen.queryByText("Beta Deli")).toBeNull());
  });

  it("refetches the list when a routing build finishes while Stores is open", async () => {
    let routing: "building" | "ready" = "building";
    const { calls, client, db } = renderTab({ "GET /api/projects/p1": () => makeProject({ routing_status: routing }) });
    expect(await screen.findByText("Alpha Mart")).toBeTruthy();
    const listCalls = () => calls.filter((call) => call.method === "GET" && call.url.pathname === "/api/projects/p1/stores").length;
    const before = listCalls();

    // The worker routes the stores and releases the slot; the next project poll sees "ready".
    db.set("u1", { ...(db.get("u1") as Stop), installer: "Zed", day: 3 });
    routing = "ready";
    await act(() => client.refetchQueries({ queryKey: keys.project("p1"), exact: true }));

    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
    expect(await screen.findByText("Zed · day 3")).toBeTruthy();
  });

  it("shows the v2 columns and maps filters, search and sort onto the API", async () => {
    const { calls } = renderTab();
    expect(await screen.findByText("Alpha Mart")).toBeTruthy();
    for (const name of [/IBC#/, /City, state/, /Status/, /Screens/, /Installer \/ day/, /PA/, /DMA/, /Committed Dolphin/]) {
      expect(screen.getByRole("columnheader", { name })).toBeTruthy();
    }
    expect(screen.getByLabelText("Status of IBC-2").textContent).toBe("Completed"); // derived status, read-only
    expect(screen.getByLabelText(/^1 screens: 1 Upcoming/)).toBeTruthy();
    expect(screen.getByText("North")).toBeTruthy(); // PA falls back to the project's
    expect(screen.getByText("South")).toBeTruthy();
    expect(screen.getByText("2 / —")).toBeTruthy(); // committed Dolphin / store TVs
    expect(screen.getByText(/no Google Maps browser key/)).toBeTruthy(); // map degrades, table works

    await userEvent.click(screen.getByRole("button", { name: "Completed" }));
    await waitFor(() => expect(lastList(calls)?.searchParams.getAll("status")).toEqual(["Completed"]));
    await userEvent.type(screen.getByLabelText("Search stores"), "oak");
    await waitFor(() => expect(lastList(calls)?.searchParams.get("q")).toBe("oak"), { timeout: 2000 });
    const pins = [...calls].reverse().find((call) => call.url.pathname.endsWith("/pins"))?.url;
    expect(pins?.searchParams.get("q")).toBe("oak");

    await userEvent.click(within(screen.getByRole("columnheader", { name: /Store name/ })).getByRole("button"));
    await waitFor(() => expect(lastList(calls)?.searchParams.get("dir")).toBe("desc"));
    await userEvent.click(within(screen.getByRole("columnheader", { name: /Screens/ })).getByRole("button"));
    await waitFor(() => expect(lastList(calls)?.searchParams.get("sort")).toBe("screens"));

    const csv = screen.getByRole("link", { name: /CSV/ }).getAttribute("href") ?? "";
    expect(csv).toContain("/api/projects/p1/stores/export.csv");
    expect(new URL(csv).searchParams.getAll("status")).toEqual(["Completed"]);
  });

  it("edits a store name inline and sends only that field", async () => {
    const { calls } = renderTab();
    await userEvent.click(await screen.findByRole("button", { name: "Edit store name of IBC-1" }));
    const input = screen.getByLabelText("store name of IBC-1");
    await userEvent.clear(input);
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByText("Store name is required")).toBeTruthy();
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
    await userEvent.type(input, "Alpha Market{Enter}");
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ store_name: "Alpha Market" }));
    expect(await screen.findByText("Alpha Market")).toBeTruthy();
  });

  it("drawer: §3 sections, read-only IBC# and PA, validation, tri-states, masked password, links", async () => {
    const { calls } = renderTab();
    const drawer = await openDrawer();
    const sections = within(drawer).getAllByRole("region").map((region) => region.getAttribute("aria-label"));
    expect(sections).toEqual([
      "Identity & address", "Contacts", "Installation", "Site notes", "Site checklist", "Screen counts", "Screens",
      "Screen rows", "Progress", "Other imported data",
    ]);
    expect(within(drawer).getByLabelText("IBC#").textContent).toBe("IBC-1");
    expect(within(drawer).getByLabelText("PA").textContent).toContain("North"); // project fallback
    expect(within(drawer).queryByRole("textbox", { name: "IBC#" })).toBeNull();

    await userEvent.type(within(drawer).getByLabelText("Store owner email"), "nope");
    await userEvent.click(within(drawer).getByRole("checkbox", { name: "Spot visible from most of store: Unknown" }));
    expect(within(drawer).getByRole("checkbox", { name: "Spot visible from most of store: Yes" })).toBeTruthy();
    await userEvent.click(within(drawer).getByRole("button", { name: "Save details" }));
    expect(await within(drawer).findByText("Store owner email: enter a valid email")).toBeTruthy();
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);

    await userEvent.clear(within(drawer).getByLabelText("Store owner email"));
    const password = within(drawer).getByLabelText("Store SSID password") as HTMLInputElement;
    expect(password.type).toBe("password");
    await userEvent.click(within(drawer).getByRole("button", { name: "Show password" }));
    expect(password.type).toBe("text");
    await userEvent.type(within(drawer).getByLabelText("Pictures (image URL)"), "https://img.test/a.jpg https://img.test/b.jpg");
    expect(within(within(drawer).getByLabelText("Pictures (image URL) links")).getAllByRole("link")).toHaveLength(2);
    await userEvent.click(within(drawer).getByRole("button", { name: "Save details" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
        spot_visible: true, image_url: "https://img.test/a.jpg https://img.test/b.jpg",
      }),
    );
  });

  it("drawer: screens editor adds, edits and deletes rows and saves them as a full replace", async () => {
    const { calls } = renderTab();
    const drawer = await openDrawer();
    const rows = within(drawer).getByRole("region", { name: "Screen rows" });
    expect(within(rows).getByTestId("derived-status").textContent).toBe("Upcoming");
    expect(within(rows).getByRole("button", { name: "Delete screen 1" }).hasAttribute("disabled")).toBe(true); // ≥ 1 row

    await userEvent.click(within(rows).getByRole("button", { name: "Add screen" }));
    const second = within(rows).getByRole("listitem", { name: "Screen 2" });
    expect(within(second).getByRole("checkbox", { name: "Dolphin screen, screen 2" }).getAttribute("aria-checked")).toBe("true");
    await userEvent.type(within(second).getByLabelText("DD code"), "V9");
    await userEvent.click(within(second).getByRole("checkbox", { name: "Dolphin screen, screen 2" }));
    await userEvent.click(within(rows).getByRole("combobox", { name: "Status of screen 1" }));
    await userEvent.click(await screen.findByRole("option", { name: "Completed" }));
    expect(within(rows).getByTestId("derived-status").textContent).toBe("Upcoming"); // the new row is still Upcoming
    expect(within(rows).getByText(/2 screens · 1 Dolphin · 1 store TVs/)).toBeTruthy();

    await userEvent.click(within(rows).getByRole("button", { name: "Add screen" }));
    await userEvent.click(within(rows).getByRole("button", { name: "Delete screen 3" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete this screen?" }); // on top of the drawer
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete screen" }));
    expect(within(rows).queryByRole("listitem", { name: "Screen 3" })).toBeNull();

    await userEvent.click(within(rows).getByRole("button", { name: "Save screens" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PUT")).toBeTruthy());
    const body = calls.find((call) => call.method === "PUT")?.body as { screens: ScreenInput[] };
    expect(body.screens).toEqual([
      expect.objectContaining({ id: "u1-s1", status: "Completed" }),
      expect.objectContaining({ venue_id: "V9", is_dolphin_screen: false, status: "Upcoming", has_ceiling_mount: false }),
    ]);
    expect(body.screens[1]).not.toHaveProperty("id"); // new rows get their id from the server
  });

  it("table status follows a screens save at once and rolls back on error", async () => {
    let release: (value: Response) => void = () => {};
    renderTab({ "PUT /api/projects/p1/stores/u1/screens": () => new Promise<Response>((resolve) => (release = resolve)) });
    const drawer = await openDrawer();
    const rows = within(drawer).getByRole("region", { name: "Screen rows" });
    await userEvent.click(within(rows).getByRole("combobox", { name: "Status of screen 1" }));
    await userEvent.click(await screen.findByRole("option", { name: "Delivered" }));
    await userEvent.click(within(rows).getByRole("button", { name: "Save screens" }));
    await waitFor(() => expect(screen.getByLabelText("Status of IBC-1").textContent).toBe("Delivered")); // optimistic
    await act(async () => release(jsonError(500, "boom")));
    await waitFor(() => expect(screen.getByLabelText("Status of IBC-1").textContent).toBe("Upcoming"));
  });

  it("opens the drawer and offers Google's suggestions when an address cannot be verified", async () => {
    const { calls } = renderTab({
      "PATCH /api/projects/p1/stores/u1": () =>
        jsonError(422, { message: "Address could not be verified by Google.", google_status: "ZERO_RESULTS", suggestions: ["1 Main St NW, Atlanta, GA 30303, USA"] }),
      "GET /api/places/validate": () => ({
        ok: true, status: "OK", formatted: "1 Main St NW, Atlanta, GA 30303, USA", lat: 33.76, lng: -84.39,
        addr: "1 Main St NW", city: "Atlanta", state: "GA", zip: "30303", partial: false, suggestions: [], error: "",
      }),
    });
    const drawer = await openDrawer();
    const addr = await within(drawer).findByLabelText("Address *");
    await userEvent.clear(addr);
    await userEvent.type(addr, "1 Mian");
    await userEvent.click(within(drawer).getByRole("button", { name: "Verify address and save" }));
    expect(await within(drawer).findByRole("alert")).toBeTruthy();
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ addr: "1 Mian" });
    await userEvent.click(within(drawer).getByRole("button", { name: "1 Main St NW, Atlanta, GA 30303, USA" }));
    await waitFor(() => expect((within(drawer).getByLabelText("Address *") as HTMLInputElement).value).toBe("1 Main St NW"));
    expect(within(drawer).queryByRole("alert")).toBeNull();
  });

  it("saves progress from the drawer without touching details", async () => {
    const { calls } = renderTab();
    const drawer = await openDrawer();
    await userEvent.click(within(drawer).getByLabelText("Additional task done"));
    await userEvent.type(within(drawer).getByLabelText("Comment"), "Left a note");
    await userEvent.click(within(drawer).getByLabelText("Completed by")); // blur the comment
    await waitFor(() => expect(calls.filter((call) => call.url.pathname.endsWith("/progress")).length).toBe(2));
    const bodies = calls.filter((call) => call.url.pathname.endsWith("/progress")).map((call) => call.body);
    expect(bodies).toEqual([{ additional_task: true }, { comment: "Left a note" }]);
    expect(calls.some((call) => call.method === "PATCH" && call.url.pathname === "/api/projects/p1/stores/u1")).toBe(false);
  });
});
