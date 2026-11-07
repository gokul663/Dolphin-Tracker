import { Profiler } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { ProjectPage } from "@/features/projects/ProjectPage";
import { StoresTab } from "@/features/stores/StoresTab";
import { jsonError, mockApi, renderWithProviders } from "@/test/render";
import { makeStop, makeSummary } from "@/test/fixtures";
import { useStoresUi } from "@/stores/ui";
import { keys } from "@/lib/api/keys";
import { deriveStatus, type ScreenInput, type Stop } from "@/lib/api/types";
import { STORE_FIELDS_FOR_TESTS } from "@/test/storeFields";
import { makeRoutePlan } from "@/test/planFixtures";

const STOPS: Stop[] = [
  makeStop({ pa: "", committed_dolphin_screens: 2 }),
  makeStop({
    uid: "u2", display_id: "S2", external_id: "IBC-2", store_name: "Beta Deli", addr: "2 Oak St", city: "Decatur",
    status: "Completed", installer: "Bo", lat: 33.8, pa: "South",
  }),
];

const FILTER_OPTIONS = {
  status: [{ value: "Upcoming", count: 1 }, { value: "Completed", count: 1 }],
  installer: [{ value: "Ann", count: 1 }, { value: "Bo", count: 1 }],
  pa: [{ value: "North", count: 1 }, { value: "South", count: 1 }],
  state: [{ value: "GA", count: 2 }],
  city: [{ value: "Atlanta", count: 1 }, { value: "Decatur", count: 1 }],
  dma: [{ value: "ATL", count: 2 }],
  venue_type: [],
  dd_code: [],
  screen_size: [],
};

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
    "GET /api/projects/p1": () => makeSummary(),
    "GET /api/projects/p1/stores": (url) => {
      // The server keeps only stores inside the map view when all four edges are given.
      const edge = (name: string) => Number(url.searchParams.get(name));
      const inView = (stop: Stop) =>
        !url.searchParams.has("north") ||
        (stop.lat !== null && stop.lng !== null && stop.lat >= edge("south") && stop.lat <= edge("north") && stop.lng >= edge("west") && stop.lng <= edge("east"));
      const items = [...db.values()].filter(inView);
      return { items, next_cursor: null, total: items.length, offset: 0 };
    },
    "GET /api/projects/p1/stores/pins": () =>
      [...db.values()].map(({ uid, lat, lng, status, store_name, installer, day, screens }) => ({
        uid, lat, lng, status, store_name, installer, day, screen_statuses: screens.map((s) => s.status),
      })),
    "GET /api/config/maps": () => ({ google_maps_browser_key: "" }),
    "GET /api/route-plans": () => ({ items: [makeRoutePlan({ id: "plan9", name: "GA week" })], next_cursor: null }),
    "GET /api/projects/p1/stores/u1/visits": () => ({ items: [], next_cursor: null }),
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
    "GET /api/projects/p1/stores/filters": () => FILTER_OPTIONS,
    "GET /api/projects/p1/stores/by-state": () => [{ state: "GA", count: 2 }, { state: "TN", count: 1 }],
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
    const { calls } = renderTab({}, () => (renders += 1));
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
    const last = calls.filter((call) => call.url.pathname === "/api/projects/p1/stores").at(-1)!;
    expect(last.url.searchParams.get("north")).toBe("33.75"); // the map view goes to the server
    expect(last.url.searchParams.get("offset")).toBe("0");
  });

  it("pages through the stores by number, with the total", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...STOPS[0]!, uid: `s${i}`, store_name: `Store ${String(i).padStart(3, "0")}` }));
    const { calls } = renderTab({
      "GET /api/projects/p1/stores": (url) => {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Number(url.searchParams.get("limit"));
        return { items: many.slice(offset, offset + limit), next_cursor: null, total: many.length, offset };
      },
    });
    expect(await screen.findByText("Store 000")).toBeTruthy();
    const pager = screen.getByRole("navigation", { name: "Pages" });
    expect(within(pager).getByText("1–20 of 60")).toBeTruthy();
    expect(within(pager).getByText(/of 3/)).toBeTruthy();
    expect((within(pager).getByRole("button", { name: "Previous page" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(pager).getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Store 020")).toBeTruthy();
    expect(within(pager).getByText("21–40 of 60")).toBeTruthy();
    await userEvent.click(within(pager).getByRole("button", { name: "Last page" }));
    expect(await within(pager).findByText("41–60 of 60")).toBeTruthy();
    expect((within(pager).getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.selectOptions(within(pager).getByRole("combobox", { name: "Rows per page" }), "50");
    expect(await within(pager).findByText("1–50 of 60")).toBeTruthy(); // a new page size starts again at page 1
    const last = calls.filter((call) => call.url.pathname === "/api/projects/p1/stores").at(-1)!;
    expect([last.url.searchParams.get("offset"), last.url.searchParams.get("limit")]).toEqual(["0", "50"]);
  });

  it("one Locations / Screens switch drives the map legend and the top-states chart", async () => {
    const pin = { lng: -84.39, installer: "Ann", day: 1, route_plan_id: "", visit_state: "none" };
    const { calls } = renderTab({
      "GET /api/projects/p1/stores/pins": () => [
        { ...pin, uid: "u1", lat: 33.7, status: "Upcoming", store_name: "Alpha Mart", screen_statuses: ["Upcoming"] },
        { ...pin, uid: "u2", lat: 33.8, status: "Completed", store_name: "Beta Deli", screen_statuses: ["Completed", "Completed"] },
      ],
    });
    await screen.findByText("Alpha Mart");
    const byState = () => calls.filter((call) => call.url.pathname.endsWith("/by-state")).at(-1)!.url;
    await waitFor(() => expect(byState().searchParams.get("unit")).toBe("stores"));
    expect(byState().searchParams.get("limit")).toBe("60"); // every state, not just the top ten
    const legend = screen.getByRole("group", { name: "Map legend" });
    const before = within(legend).getAllByRole("button").map((button) => button.textContent);
    await userEvent.click(screen.getByRole("radio", { name: "Screens" }));
    expect(screen.getByRole("radio", { name: "Screens" }).getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(byState().searchParams.get("unit")).toBe("screens"));
    expect(await screen.findByRole("region", { name: "Top states by upcoming screens" })).toBeTruthy();
    const totals = screen.getByText((_, element) => element?.getAttribute("aria-live") === "polite" && /^\d+ screens · \d+ records/.test(element.textContent ?? ""));
    expect(totals).toBeTruthy();
    expect(before).toEqual(["Upcoming 1", "Completed 1"]); // stores
    expect(within(legend).getAllByRole("button").map((button) => button.textContent)).toEqual(["Upcoming 1", "Completed 2"]); // screens
  });

  it("refetches the list when a routing build finishes while Stores is open", async () => {
    let routing: "building" | "ready" = "building";
    const { calls, client, db } = renderTab({ "GET /api/projects/p1": () => makeSummary({ routing_status: routing }) });
    expect(await screen.findByText("Alpha Mart")).toBeTruthy();
    const listCalls = () => calls.filter((call) => call.method === "GET" && call.url.pathname === "/api/projects/p1/stores").length;
    const before = listCalls();

    // The worker routes the stores and releases the slot; the next project poll sees "ready".
    db.set("u1", { ...(db.get("u1") as Stop), store_name: "Alpha Mart (routed)" });
    routing = "ready";
    await act(() => client.refetchQueries({ queryKey: keys.project("p1"), exact: true }));

    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
    expect(await screen.findByText("Alpha Mart (routed)")).toBeTruthy();
  });

  it("marks stores in a route (with the plan) and visited stores, and tints their rows", async () => {
    const routed = { ...STOPS[0]!, route_plan_id: "plan9", last_planned_at: "2026-11-01" };
    const visited = { ...STOPS[1]!, screen_visits: { [STOPS[1]!.screens[0]!.id]: "2026-11-02" }, last_visit_at: "2026-11-02T10:00:00Z" };
    renderTab({ "GET /api/projects/p1/stores": () => ({ items: [routed, visited], next_cursor: null, total: 2, offset: 0 }) });
    const link = await screen.findByRole("link", { name: /GA week/ });
    expect(link.getAttribute("href")).toBe("/planner/plan9");
    expect(screen.getAllByText("Visited").some((node) => node.closest("[data-uid=\"u2\"]"))).toBe(true);
    const rows = screen.getAllByRole("row").filter((row) => row.getAttribute("data-uid"));
    expect(rows.find((row) => row.getAttribute("data-uid") === "u1")?.className).toContain("bg-blue-50");
    expect(rows.find((row) => row.getAttribute("data-uid") === "u2")?.className).toContain("bg-emerald-50");
  });

  it("a single-PA project leaves out the PA column", async () => {
    renderTab({ "GET /api/projects/p1/stores": () => ({ items: [STOPS[0]], next_cursor: null, total: 1, offset: 0 }) });
    expect(await screen.findByText("Alpha Mart")).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: /^PA/ })).toBeNull();
    expect(screen.getByRole("columnheader", { name: /DMA/ })).toBeTruthy();
  });

  it("shows the v2 columns and maps filters, search and sort onto the API", async () => {
    const { calls } = renderTab();
    expect(await screen.findByText("Alpha Mart")).toBeTruthy();
    for (const name of [/IBC#/, /City, state/, /Status/, /Screens/, /Route \/ visits/, /PA/, /DMA/, /Committed Dolphin/]) {
      expect(screen.getByRole("columnheader", { name })).toBeTruthy();
    }
    expect(screen.getByLabelText("Status of IBC-2").textContent).toBe("Completed"); // derived status, read-only
    expect(screen.getByLabelText(/^1 screens: 1 Upcoming/)).toBeTruthy();
    expect(screen.getByText("North")).toBeTruthy(); // PA falls back to the project's
    expect(screen.getByText("South")).toBeTruthy();
    expect(screen.getByText("2 / —")).toBeTruthy(); // committed Dolphin / store TVs
    expect(screen.getByText(/no Google Maps browser key/)).toBeTruthy(); // map degrades, table works

    await userEvent.click(within(screen.getByRole("group", { name: "Filters" })).getByRole("button", { name: "Status" }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Completed/ }));
    await userEvent.keyboard("{Escape}");
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

  it("store modal: WiFi first, collapsible sections, read-only IBC# and PA, validation, tri-states, password, pictures", async () => {
    const { calls } = renderTab();
    const drawer = await openDrawer();
    const sections = within(drawer).getAllByRole("region", { hidden: true }).map((region) => region.getAttribute("aria-label"));
    expect(sections).toEqual([
      "WiFi", "Identity & address", "Contacts", "Installation", "Site notes", "Site checklist", "Screen counts", "Screens",
      "Screen rows", "Servicing history", "Progress", "Other imported data", "Pictures",
    ]);
    const toggle = (name: string) => within(drawer).getByRole("button", { name: new RegExp(`^${name}`) });
    expect(toggle("WiFi").getAttribute("aria-expanded")).toBe("true");
    expect(toggle("Contacts").getAttribute("aria-expanded")).toBe("false");
    expect(within(drawer).queryByRole("textbox", { name: "Store owner email" })).toBeNull(); // collapsed
    await userEvent.click(toggle("Contacts"));
    await userEvent.click(toggle("Site checklist"));
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
    await waitFor(() => expect(within(drawer).getAllByRole("img", { name: "Store picture" })).toHaveLength(2)); // previews
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
    const check = calls.find((call) => call.url.pathname === "/api/places/validate")!.url;
    expect(check.searchParams.get("name")).toBe("Alpha Mart"); // Google can place the business itself
    expect(within(drawer).queryByText(/Google's pin/)).toBeNull();
    // A suggestion picked by mistake can be undone.
    await userEvent.click(within(drawer).getByRole("button", { name: "Undo" }));
    expect((within(drawer).getByLabelText("Address *") as HTMLInputElement).value).toBe("1 Mian");
  });

  it("when the address cannot be verified, Search Google lists places and saves the store at the one picked", async () => {
    let tries = 0;
    const { calls } = renderTab({
      "PATCH /api/projects/p1/stores/u1": (_url, init) => {
        tries += 1;
        const body = JSON.parse(String(init.body)) as { place?: unknown };
        return body.place ? makeStop() : jsonError(422, { message: "Address could not be verified by Google.", suggestions: [] });
      },
      "GET /api/places/search": () => [
        { place_id: "p1", name: "Sunset Gas And Grill", formatted: "Sunset, TX 76270", lat: 33.45, lng: -97.77, addr: "", city: "Sunset", state: "TX", zip: "76270" },
      ],
    });
    const drawer = await openDrawer();
    const addr = await within(drawer).findByLabelText("Address *");
    await userEvent.clear(addr);
    await userEvent.type(addr, "101 S Council Rd");
    await userEvent.click(within(drawer).getByRole("button", { name: "Verify address and save" }));
    await userEvent.click(await within(drawer).findByRole("button", { name: "Search Google" }));
    const results = await screen.findByRole("list", { name: "Google results" });
    const search = calls.find((call) => call.url.pathname === "/api/places/search")!.url;
    expect(search.searchParams.get("name")).toBe("Alpha Mart");
    expect(search.searchParams.get("address")).toContain("101 S Council Rd");
    await userEvent.click(within(results).getByRole("button", { name: /Sunset Gas And Grill/ }));
    await waitFor(() => expect(tries).toBe(2));
    expect(calls.filter((call) => call.method === "PATCH").at(-1)?.body).toEqual({
      addr: "101 S Council Rd",
      place: { lat: 33.45, lng: -97.77, formatted: "Sunset Gas And Grill · Sunset, TX 76270" },
    });
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

  it("filter bar: STORE-MODEL §5 order, counts, greyed-out empties, and every filter reaches the list and map", async () => {
    const { calls } = renderTab();
    await screen.findByText("Alpha Mart");
    const bar = screen.getByRole("group", { name: "Filters" });
    expect(within(bar).getAllByRole("button").map((button) => button.textContent?.replace("no values", "").trim())).toEqual([
      "Status", "Route", "Visits", "Installer", "PA", "State", "City", "DMA", "Venue type", "DD code", "Screen size",
    ]);
    for (const name of ["Venue type (no values)", "DD code (no values)", "Screen size (no values)"]) {
      expect(within(bar).getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
    }
    await userEvent.click(within(bar).getByRole("button", { name: "Status" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: /Upcoming/ })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /Search/ })).toBeNull(); // short fixed list: no search box
    await userEvent.keyboard("{Escape}");
    await userEvent.click(within(bar).getByRole("button", { name: "City" }));
    const search = await screen.findByRole("textbox", { name: "Search City" });
    await userEvent.type(search, "dec");
    expect(screen.queryByRole("menuitemcheckbox", { name: /Atlanta/ })).toBeNull();
    expect((search as HTMLInputElement).value).toBe("dec"); // typing stays in the box
    await userEvent.clear(search);
    await userEvent.type(search, "zzz");
    expect(screen.getByText("No match")).toBeTruthy();
    await userEvent.clear(search);
    expect(await screen.findByRole("menuitemcheckbox", { name: /Decatur\s*1/ })).toBeTruthy();
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: /Decatur/ }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(lastList(calls)?.searchParams.getAll("city")).toEqual(["Decatur"]));
    const pins = [...calls].reverse().find((call) => call.url.pathname.endsWith("/pins"))?.url;
    expect(pins?.searchParams.getAll("city")).toEqual(["Decatur"]);
    const facets = [...calls].reverse().find((call) => call.url.pathname.endsWith("/filters"))?.url;
    expect(facets?.searchParams.getAll("city")).toEqual(["Decatur"]); // options are counted under the selection
    expect(within(bar).getByRole("button", { name: "City: Decatur" })).toBeTruthy();
  });

  it("top states: a bar selects its state alone, a second click clears it, other filters are kept", async () => {
    const { calls } = renderTab();
    await screen.findByText("Alpha Mart");
    await userEvent.click(within(screen.getByRole("group", { name: "Filters" })).getByRole("button", { name: "DMA" }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: /ATL/ }));
    await userEvent.keyboard("{Escape}");
    const chart = await screen.findByRole("region", { name: "Top states by upcoming installs" });
    const ga = within(chart).getByRole("button", { name: "GA 2" });
    await userEvent.click(ga);
    await waitFor(() => expect(lastList(calls)?.searchParams.getAll("state")).toEqual(["GA"]));
    expect(lastList(calls)?.searchParams.getAll("dma")).toEqual(["ATL"]);
    expect(within(chart).getByRole("button", { name: "GA 2" }).getAttribute("aria-pressed")).toBe("true");
    const byState = [...calls].reverse().find((call) => call.url.pathname.endsWith("/by-state"))?.url;
    expect(byState?.searchParams.getAll("state")).toEqual([]); // the chart never filters itself by state
    expect(byState?.searchParams.get("pending")).toBe("true");
    await userEvent.click(within(chart).getByRole("button", { name: "GA 2" }));
    await waitFor(() => expect(lastList(calls)?.searchParams.getAll("state")).toEqual([]));
    expect(lastList(calls)?.searchParams.getAll("dma")).toEqual(["ATL"]);
  });
});
