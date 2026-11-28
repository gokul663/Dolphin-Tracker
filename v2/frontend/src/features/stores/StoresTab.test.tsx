import { Profiler } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { ProjectPage } from "@/features/projects/ProjectPage";
import { StoresTab } from "@/features/stores/StoresTab";
import { jsonError, mockApi, renderWithProviders } from "@/test/render";
import { makeScreen, makeStop, makeSummary } from "@/test/fixtures";
import { useStoresUi } from "@/stores/ui";
import { keys } from "@/lib/api/keys";
import { deriveStatus, type ScreenInput, type Stop } from "@/lib/api/types";
import { STORE_FIELDS_FOR_TESTS } from "@/test/storeFields";
import { makeRoutePlan } from "@/test/planFixtures";
import { tagTone } from "@/features/stores/tagTone";

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
  technician: [{ value: "Sai", count: 1 }, { value: "", count: 1 }],
  pa: [{ value: "North", count: 1 }, { value: "South", count: 1 }],
  state: [{ value: "GA", count: 2 }],
  city: [{ value: "Atlanta", count: 1 }, { value: "Decatur", count: 1 }],
  dma: [{ value: "ATL", count: 2 }],
  venue_type: [],
  dd_code: [],
  screen_size: [],
  bucket: [{ value: "Completed", count: 1 }, { value: "Upcoming", count: 1 }],
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
    "GET /api/projects/p1/stores/screens": () => {
      const items = [...db.values()].flatMap((stop) =>
        stop.screens.map((row) => ({
          uid: stop.uid, external_id: stop.external_id, display_id: stop.display_id, store_name: stop.store_name, addr: stop.addr,
          city: stop.place_city, state: stop.place_state, installer_name: stop.installer_name, install_type: stop.install_type, screen: row,
        })),
      );
      return { items, total: items.length, offset: 0 };
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
    "GET /api/projects/p1/stores/hardware": () => ({ installed_screens: 0, installed_stores: 0, installed_dolphin_by_model: {} }),
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
    await userEvent.click(within(pager).getByRole("combobox", { name: "Rows per page" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["15 / page", "20 / page", "30 / page", "50 / page"]);
    await userEvent.click(screen.getByRole("option", { name: "50 / page" }));
    expect(await within(pager).findByText("1–50 of 60")).toBeTruthy(); // a new page size starts again at page 1
    const last = calls.filter((call) => call.url.pathname === "/api/projects/p1/stores").at(-1)!;
    expect([last.url.searchParams.get("offset"), last.url.searchParams.get("limit")]).toEqual(["0", "50"]);
  });

  it("the Stores / Screens view drives the table, the map legend and the top-states chart", async () => {
    const pin = { lng: -84.39, installer: "Ann", day: 1, route_plan_id: "", visit_state: "none" };
    const { calls } = renderTab({
      "GET /api/projects/p1/stores/pins": () => [
        { ...pin, uid: "u1", lat: 33.7, status: "Upcoming", store_name: "Alpha Mart", screen_statuses: ["Upcoming"] },
        { ...pin, uid: "u2", lat: 33.8, status: "Completed", store_name: "Beta Deli", screen_statuses: ["Completed", "Completed"] },
      ],
    });
    await screen.findByText("Alpha Mart");
    const byState = () => calls.filter((call) => call.url.pathname.endsWith("/overview")).at(-1)!.url;
    await waitFor(() => expect(byState().searchParams.get("unit")).toBe("stores"));
    expect(byState().searchParams.get("limit")).toBe("60"); // every state, not just the top ten
    const legend = screen.getByRole("group", { name: "Map legend" });
    expect(legend.parentElement?.contains(screen.getByRole("link", { name: /Open map in a new tab/ }))).toBe(true);
    const before = within(legend).getAllByRole("listitem").map((item) => item.textContent);
    // The page header's Stores | Screens switch sets the view; no second switch on the map.
    expect(screen.queryByRole("radio", { name: "Screens" })).toBeNull();
    act(() => useStoresUi.getState().setUnit("screens"));
    // The table lists screens, one row each, with the store it is at.
    const grid = await screen.findByRole("grid", { name: "Screens" });
    expect(within(grid).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "DD code", "ExtID", "Store name", "Address", "City", "State", "Screen status", "Installer", "Cost", "Screen size", "Owner", "Brand", "Venue type",
    ]);
    expect(within(grid).getAllByRole("row")).toHaveLength(1 + STOPS.reduce((sum, stop) => sum + stop.screens.length, 0));
    expect(within(grid).getAllByText("Alpha Mart").length).toBeGreaterThan(0);
    expect(screen.queryByRole("grid", { name: "Stores" })).toBeNull();
    await waitFor(() => expect(byState().searchParams.get("unit")).toBe("screens"));
    expect(await screen.findByRole("region", { name: "Top states by screens" })).toBeTruthy();
    const totals = screen.getByText((_, element) => element?.getAttribute("aria-live") === "polite" && /^\d+ pins · \d+ screens$/.test(element.textContent ?? ""));
    expect(totals).toBeTruthy();
    const rest = ["Offline 0", "Archived 0", "Cancelled 0"];
    // Stores read In Progress where screens read Not Registered (a per-screen status).
    expect(before).toEqual(["Upcoming 1", "Online 1", ...rest, "In Progress 0"]);
    expect(within(legend).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Upcoming 1", "Online 2", ...rest, "Not Registered 0"]);
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

  it("a store whose installed screens and TVs reach the committed count gets a check, not a green row", async () => {
    const done = makeStop({
      uid: "u9", external_id: "IBC-9", store_name: "Done Mart", committed_dolphin_screens: 1, committed_store_tvs: 1,
      screens: [makeScreen({ id: "a", status: "Completed" }), makeScreen({ id: "b", status: "Completed", is_dolphin_screen: false })],
      status: "Completed",
    });
    renderTab({ "GET /api/projects/p1/stores": () => ({ items: [done, STOPS[0]], next_cursor: null, total: 2, offset: 0 }) });
    expect(await screen.findByText("Done Mart")).toBeTruthy();
    const rows = screen.getAllByRole("row").filter((row) => row.getAttribute("data-uid"));
    expect(rows.find((row) => row.getAttribute("data-uid") === "u9")?.className).not.toContain("bg-green");
    expect(within(rows.find((row) => row.getAttribute("data-uid") === "u9")!).getByLabelText("fulfilled")).toBeTruthy();
    // One total per column; the Dolphin screens and store TVs apart on hover.
    expect(screen.getByLabelText("Screens committed: 2 (1 Dolphin screen · 1 store TV)")).toBeTruthy();
    const installed = screen.getByLabelText("Screens installed: 2 (1 Dolphin screen · 1 store TV)");
    await userEvent.hover(installed);
    expect((await screen.findAllByText("1 store TV")).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Table legend").textContent).toContain("store TVs");
  });

  it("Add store checks the row like a sheet does, then opens the new store", async () => {
    let attempt = 0;
    const added = makeStop({ uid: "u7", external_id: "GA90001", store_name: "New Mart" });
    const duplicate = "ExtID GA90001 is already in the project: Alpha Mart";
    const { calls } = renderTab({
      "POST /api/projects/p1/stores": () => {
        attempt += 1;
        if (attempt === 1) return jsonError(422, { message: duplicate, fields: { external_id: duplicate } });
        if (attempt === 2) return jsonError(422, { message: "Address could not be verified by Google.", suggestions: ["9 New St, Macon, GA 31201, USA"] });
        return added;
      },
      "GET /api/projects/p1/stores/u7": () => added,
    });
    await screen.findByText("Alpha Mart");
    expect(screen.getByRole("button", { name: /Upload sheet/ })).toBeTruthy(); // beside it; the sheets are listed in Settings
    await userEvent.click(screen.getByRole("button", { name: /Add store/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add a store" });
    // ExtID, store name and address are needed before anything is sent.
    await userEvent.click(within(dialog).getByRole("button", { name: "Add store" }));
    expect(within(dialog).getAllByRole("alert").map((alert) => alert.textContent)).toEqual(["ExtID is required", "Store name is required", "Address is required"]);
    const posts = () => calls.filter((call) => call.method === "POST" && call.url.pathname === "/api/projects/p1/stores");
    expect(posts()).toHaveLength(0);
    await userEvent.type(within(dialog).getByLabelText("ExtID *"), "GA90001");
    await userEvent.type(within(dialog).getByLabelText("Store name *"), "New Mart");
    await userEvent.type(within(dialog).getByLabelText("Address *"), "9 New");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add store" }));
    expect(await within(dialog).findByText(duplicate)).toBeTruthy(); // a duplicate names the store that has it
    await userEvent.click(within(dialog).getByRole("button", { name: "Add store" }));
    // Google could not verify it: its suggestion is sent as the address.
    await userEvent.click(await within(dialog).findByRole("button", { name: /9 New St, Macon/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a store" })).toBeNull());
    expect(posts().at(-1)?.body).toEqual({ external_id: "GA90001", store_name: "New Mart", addr: "9 New St, Macon, GA 31201, USA", city: "", state: "", zip: "" });
    expect(await screen.findByRole("dialog", { name: /GA90001/ })).toBeTruthy(); // the new store's window
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
    for (const name of [/ExtID/, /^City/, /^State/, /Status/, /^Screens$/, /Route \/ visits/, /PA/, /DMA/, /^Screens committed/, /^Screens installed/, /^Installer/]) {
      expect(screen.getByRole("columnheader", { name })).toBeTruthy();
    }
    const headers = screen.getAllByRole("columnheader").map((header) => header.textContent ?? "");
    const at = (name: string) => headers.findIndex((text) => text.startsWith(name));
    expect(at("DMA")).toBe(at("City") + 1); // City, DMA, State, in that order, before Status
    expect(at("State")).toBe(at("DMA") + 1);
    expect(at("Status")).toBe(at("State") + 1);
    expect(screen.queryByRole("columnheader", { name: /Registered/ })).toBeNull(); // per screen: in the store window
    expect(screen.getByLabelText("Project PA").textContent).toBe("PA · North"); // the project's PA, under its name
    expect(headers.filter((text) => text.startsWith("Install"))).toEqual(["Installer"]); // no separate Install column
    expect(headers.some((text) => text.startsWith("Technician"))).toBe(false);
    expect(screen.getByLabelText("Status of IBC-2").textContent).toBe("Completed"); // derived status, read-only
    expect(screen.getByLabelText(/^1 screens: 1 Upcoming/)).toBeTruthy();
    expect(within(screen.getByRole("grid", { name: "Stores" })).getByText("North")).toBeTruthy(); // PA falls back to the project's
    expect(screen.getByText("South")).toBeTruthy();
    expect(screen.getByLabelText("Screens committed: 2 (2 Dolphin screens · ? store TVs)")).toBeTruthy(); // total, parts on hover
    expect(screen.getByText(/no Google Maps browser key/)).toBeTruthy(); // map degrades, table works

    await userEvent.click(within(screen.getByRole("group", { name: "Filters" })).getByRole("button", { name: "Status" }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Completed/ }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(lastList(calls)?.searchParams.getAll("status")).toEqual(["Completed"]));
    await userEvent.type(screen.getByLabelText("Search stores"), "oak");
    await waitFor(() => expect(lastList(calls)?.searchParams.get("q")).toBe("oak"), { timeout: 2000 });
    await waitFor(() => expect([...calls].reverse().find((call) => call.url.pathname.endsWith("/overview"))?.url.searchParams.get("q")).toBe("oak"));

    await userEvent.click(within(screen.getByRole("columnheader", { name: /Store name/ })).getByRole("button"));
    await waitFor(() => expect(lastList(calls)?.searchParams.get("dir")).toBe("desc"));
    await userEvent.click(within(screen.getByRole("columnheader", { name: /^Screens$/ })).getByRole("button"));
    await waitFor(() => expect(lastList(calls)?.searchParams.get("sort")).toBe("screens"));

    // The CSV is fetched (with the sign-in), not a plain link, under the same filters.
    await userEvent.click(screen.getByRole("button", { name: /CSV/ }));
    const csv = await waitFor(() => {
      const call = calls.find((item) => item.url.pathname === "/api/projects/p1/stores/export.csv");
      expect(call).toBeTruthy();
      return call!;
    });
    expect(csv.url.searchParams.getAll("status")).toEqual(["Completed"]);
  });

  it("a click on a City, State, Status, Tag or Installer value filters by it; the rest of the row opens the store", async () => {
    const stop = makeStop({ uid: "u9", external_id: "IBC-9", store_name: "Sai Mart", install_type: "Technician", installer_name: "Sai", tag: "To Do" });
    const { calls } = renderTab({ "GET /api/projects/p1/stores": () => ({ items: [stop], next_cursor: null, total: 1, offset: 0 }) });
    await screen.findByText("Sai Mart");
    const row = screen.getAllByRole("row").find((element) => element.getAttribute("data-uid") === "u9")!;
    const listed = (key: string, value: string) =>
      calls.some((call) => call.method === "GET" && call.url.pathname.endsWith("/stores") && call.url.searchParams.getAll(key).includes(value));
    for (const [name, key, value] of [
      ["Filter by city: Atlanta", "city", "Atlanta"],
      ["Filter by state: GA", "state", "GA"],
      ["Filter by tag: To Do", "tag", "To Do"],
      ["Filter by installer: Sai", "technician", "Sai"],
      ["Filter by status: Upcoming", "status", "Upcoming"],
      ["Filter by route: Not in route", "route", "Not in route"],
    ] as const) {
      await userEvent.click(within(row).getByRole("button", { name }));
      await waitFor(() => expect(listed(key, value)).toBe(true));
    }
    expect(screen.queryByRole("dialog")).toBeNull(); // none of those clicks opened the store
    expect(within(screen.getByRole("group", { name: "Active filters" })).getByText(/Atlanta/)).toBeTruthy();
    await userEvent.click(within(row).getByText("Sai Mart"));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("the Installer column shows the technician's name, or a Self / Rep pill", async () => {
    const self = makeStop({ uid: "u7", external_id: "IBC-7", store_name: "Self Mart", install_type: "Self install", installer_name: "" });
    const rep = makeStop({ uid: "u8", external_id: "IBC-8", store_name: "Rep Mart", install_type: "Rep install", installer_name: "" });
    const named = makeStop({ uid: "u9", external_id: "IBC-9", store_name: "Sai Mart", install_type: "Technician", installer_name: "Sai" });
    renderTab({ "GET /api/projects/p1/stores": () => ({ items: [self, rep, named], next_cursor: null, total: 3, offset: 0 }) });
    const row = async (uid: string) => {
      await screen.findByText("Sai Mart");
      return screen.getAllByRole("row").find((element) => element.getAttribute("data-uid") === uid)!;
    };
    expect(within(await row("u7")).getByTitle("Self install").textContent).toBe("Self");
    expect(within(await row("u8")).getByTitle("Rep install").textContent).toBe("Rep");
    expect(within(await row("u9")).getByText("Sai")).toBeTruthy();
  });

  it("the store name is not edited in the table: clicking it opens the store", async () => {
    const { calls } = renderTab();
    await userEvent.click(await screen.findByText("Alpha Mart"));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Edit store name/ })).toBeNull();
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("a picture opens full size inside the store window; Esc closes the picture, not the store", async () => {
    renderTab({ "GET /api/projects/p1/stores/u1": () => ({ ...STOPS[0], image_url: "https://img.test/a.jpg https://img.test/b.jpg" }) });
    const drawer = await openDrawer();
    const pictures = within(drawer).getByRole("region", { name: "Pictures" });
    // Pictures starts open, its header counting them.
    const toggle = within(pictures).getByRole("button", { name: /^Pictures/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toContain("2 pictures");
    await waitFor(() => expect(within(pictures).getAllByRole("button", { name: "Show picture full size" })).toHaveLength(2));
    await userEvent.click(within(pictures).getAllByRole("button", { name: "Show picture full size" })[1]!);
    const viewer = within(drawer).getByRole("dialog", { name: "Store picture" }); // inside the store window
    expect(within(viewer).getByText("2 / 2")).toBeTruthy();
    await userEvent.click(within(viewer).getByRole("button", { name: "Next picture" }));
    expect(within(viewer).getByText("1 / 2")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(within(drawer).queryByRole("dialog", { name: "Store picture" })).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy(); // the store stays open
  });

  it("search suggests the closest stores as you type; picking one opens it", async () => {
    const { calls } = renderTab();
    await screen.findByText("Alpha Mart");
    await userEvent.type(screen.getByRole("combobox", { name: "Search stores" }), "alp");
    const list = await screen.findByRole("listbox", { name: "Closest stores" });
    const asked = [...calls].reverse().find((call) => call.url.pathname === "/api/projects/p1/stores" && call.url.searchParams.get("limit") === "5");
    expect(asked?.url.searchParams.get("q")).toBe("alp");
    await userEvent.click(within(list).getAllByRole("option")[0]!);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("PA is not offered as a filter when the project has a single PA", async () => {
    renderTab({ "GET /api/projects/p1/stores/filters": () => ({ ...FILTER_OPTIONS, pa: [{ value: "North", count: 2 }] }) });
    await screen.findByText("Alpha Mart");
    const bar = screen.getByRole("group", { name: "Filters" });
    await waitFor(() => expect(within(bar).queryByRole("button", { name: "PA" })).toBeNull());
    expect(within(bar).getByRole("button", { name: "State" })).toBeTruthy();
  });

  it("the store window shows the store on a small map under its pictures", async () => {
    renderTab();
    const drawer = await openDrawer();
    const location = within(drawer).getByRole("region", { name: "Location" });
    expect(within(location).getByRole("link", { name: "Open in Google Maps" }).getAttribute("href")).toContain("query=33.75,-84.39");
  });

  it("the store window's header: information chips on the left (route too), the tag with the actions on the right", async () => {
    renderTab({ "GET /api/projects/p1/stores/u1": () => ({ ...STOPS[0], tag: "In progress" }) });
    const drawer = await openDrawer();
    const standing = within(drawer).getByRole("group", { name: "Store standing" });
    const actions = within(drawer).getByRole("group", { name: "Store actions" });
    expect(within(standing).getByText("Not in a route")).toBeTruthy();
    expect(within(actions).queryByText("Not in a route")).toBeNull();
    // The tag is a control among the actions, its name shown and tinted by it.
    const tag = within(actions).getByRole("combobox", { name: "Tag" });
    expect(tag.textContent).toBe("In progress");
    expect(tag.className).toContain("bg-blue-50");
    expect(within(standing).queryByRole("combobox", { name: "Tag" })).toBeNull();
    expect(within(actions).getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("the table's Tag chip has the same colour as the store window's tag control", async () => {
    const tagged = [{ ...STOPS[0]!, tag: "Done" }, { ...STOPS[1]!, tag: "Escalated" }];
    renderTab({ "GET /api/projects/p1/stores": () => ({ items: tagged, next_cursor: null, total: 2, offset: 0 }) });
    for (const tag of ["Done", "Escalated"]) {
      const chip = await screen.findByLabelText(`Tag: ${tag}`);
      for (const name of tagTone(tag).chip.split(" ")) expect(chip.classList.contains(name), `${tag}: ${name}`).toBe(true);
    }
  });

  it("a store in a route shows the route as a chip with the others, linking to its plan", async () => {
    renderTab({ "GET /api/projects/p1/stores/u1": () => ({ ...STOPS[0], route_plan_id: "plan9" }) });
    const drawer = await openDrawer();
    const standing = within(drawer).getByRole("group", { name: "Store standing" });
    const link = await within(standing).findByRole("link", { name: "In route: GA week" });
    expect(link.getAttribute("href")).toBe("/planner/plan9");
    expect(within(drawer).queryByText("Not in a route")).toBeNull();
  });

  it("the store window's header shows its standing: CMS data sync and anything to fix", async () => {
    const device = { store_name: "Alpha Mart", venue_name: "CMS_A", address: "", addr: "1 Main St", city: "Atlanta", state: "GA",
      zip: "30303", lat: 33.75, lng: -84.39, dma: "", date: "2026-11-15" };
    renderTab({
      "GET /api/projects/p1/stores/u1": () => ({
        ...STOPS[0], device, geocoded: "", needs_attention: ["address"],
        screens: [makeScreen({ id: "u1-s1", venue_id: "DD-AAA111. DD-BBB222" })],
      }),
    });
    const drawer = await openDrawer();
    const alerts = within(drawer).getByLabelText("Store alerts");
    expect(alerts.textContent).toContain("Synced with CMS data");
    expect(alerts.textContent).toContain("Address not verified");
    expect(alerts.textContent).toContain("DD code holds several codes");
  });

  it("a store whose CMS data differs, or that is not in it, says so in the header", async () => {
    renderTab({ "GET /api/projects/p1/stores/u1": () => ({ ...STOPS[0], needs_attention: ["not_reporting"] }) });
    const drawer = await openDrawer();
    expect(within(drawer).getByLabelText("Store alerts").textContent).toContain("Not in CMS data");
  });

  it("Stick # shows the CMS data's serial number when it has one, else the sheet's", async () => {
    const device = { status: "Online", last_seen: "", offline_days: null, serial_number: "DD-002-09999", venue_name: "CMS_A", date: "2026-11-15", first_registered: "2026-10-12T14:35:34+00:00", last_registered: "" };
    renderTab({
      "GET /api/projects/p1/stores/u1": () => ({
        ...STOPS[0],
        screens: [
          makeScreen({ id: "u1-s1", venue_id: "DD-AAA111", stick_number: "DD-002-01111", device }),
          makeScreen({ id: "u1-s2", venue_id: "DD-BBB222", stick_number: "DD-002-02222" }),
        ],
      }),
    });
    const drawer = await openDrawer();
    const list = within(drawer).getByRole("region", { name: "Screen list" });
    const fromDolphin = within(list).getByLabelText("Stick number (CMS data)");
    expect(fromDolphin.textContent).toBe("DD-002-09999");
    expect(fromDolphin.getAttribute("title")).toContain("sheet: DD-002-01111");
    expect(within(list).getByLabelText("Stick number").textContent).toBe("DD-002-02222");
    // Registered is per screen: the device's last registered date, or its first when it registered only once.
    expect(within(list).getByLabelText("Registered, screen 1").textContent).toBe("2026-10-12");
    expect(within(list).queryByLabelText("Registered, screen 2")).toBeNull(); // no CMS data for it
  });

  it("Overwrite from the CMS data waits for Save details, then goes with the rest", async () => {
    const device = { store_name: "Sunoco Alpha", venue_name: "CMS_A", address: "2 Oak Ave, Atlanta, GA 30303", addr: "2 Oak Ave",
      city: "Atlanta", state: "GA", zip: "30303", lat: 33.8, lng: -84.4, dma: "", venue_type: "", date: "2026-11-15" };
    const { calls } = renderTab({ "GET /api/projects/p1/stores/u1": () => ({ ...STOPS[0], device }) });
    const drawer = await openDrawer();
    const section = within(drawer).getByRole("region", { name: "CMS data" });
    await userEvent.click(within(section).getByRole("button", { name: /Overwrite all \(3\)/ })); // name, address, location
    expect(calls.some((call) => call.method === "POST" || call.method === "PATCH")).toBe(false); // nothing saved yet
    expect(within(section).getAllByText("Unsaved")).toHaveLength(3);
    expect(within(drawer).getByText("Unsaved changes")).toBeTruthy();
    expect(within(drawer).getByLabelText("Store name").textContent).toBe("Sunoco Alpha"); // the draft shows it

    await userEvent.click(within(drawer).getByRole("button", { name: /Save details|Verify address and save/ }));
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
      store_name: "Sunoco Alpha", addr: "2 Oak Ave",
      place: { lat: 33.8, lng: -84.4, formatted: "2 Oak Ave, Atlanta, GA 30303" }, // the Dolphin pin, not a Google lookup
    }));
    expect(calls.some((call) => call.url.pathname.endsWith("/device-overwrite"))).toBe(false);
  });

  it("hardware cost sits under Top states: completed screens only, priced from Settings, following the filters", async () => {
    const { calls } = renderTab({
      "GET /api/projects/p1": () => makeSummary({ hardware_costs: { stick: 40, screens: [{ size: '24"', type: "Dolphin", cost: 120, is_default: true }, { size: '43"', type: "Dolphin", cost: 300, is_default: true }], mounts: [{ size: '24"', wall: 15, ceiling: null }, { size: '43"', wall: 30, ceiling: 50 }], hidden: false } }),
      "GET /api/projects/p1/stores/hardware": () => ({ installed_screens: 5, installed_stores: 4, installed_dolphin_by_model: { '24"|': 3, '43"|Dolphin': 1 }, mounts: { wall_24: 3, wall_other: 1, ceiling: 2 }, installed_mounts: { '24"|wall': 2, '43"|ceiling': 1 } }),
    });
    await screen.findByText("Alpha Mart");
    const chart = await screen.findByRole("region", { name: "Hardware cost" });
    // 5 sticks × 40 + 3 × 120 + 1 × 300 = 860
    await waitFor(() => expect(within(chart).getByLabelText("Hardware cost total").textContent).toBe("$860"));
    expect(chart.textContent).toContain("Completed screens only");
    const items = within(within(chart).getByRole("list", { name: "Hardware cost by item" })).getAllByRole("listitem").map((item) => item.textContent);
    expect(items).toEqual(["5 × Sticks @ $40$20023%", '3 × 24" Dolphin screens @ $120$36042%', '1 × 43" Dolphin screens @ $300$30035%']);
    // No mount counts or mount costs here: the sheets carry no mount data yet.
    expect(within(chart).queryByLabelText("Mounts")).toBeNull();
    expect(within(chart).queryByRole("checkbox", { name: "Include mount costs" })).toBeNull();
    // Under the Top states chart, in the same column.
    const states = screen.getByRole("region", { name: "Top states by stores" });
    expect(states.parentElement?.parentElement?.contains(chart)).toBe(true);
    await userEvent.click(within(screen.getByRole("group", { name: "Filters" })).getByRole("button", { name: "City" }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Decatur/ }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect([...calls].reverse().find((call) => call.url.pathname.endsWith("/overview"))?.url.searchParams.getAll("city")).toEqual(["Decatur"]),
    );
  });

  it("the address line says it is verified (green, with a check) or not (amber), in words too", async () => {
    renderTab({ "GET /api/projects/p1/stores/u1": () => ({ ...STOPS[0], geocoded: "1 Main St, Atlanta, GA 30303, USA", needs_attention: [] }) });
    const drawer = await openDrawer();
    const line = within(drawer).getByRole("note", { name: "Address verified" });
    expect(line.textContent).toBe("Verified as 1 Main St, Atlanta, GA 30303, USA");
    expect(line.className).toContain("bg-green-50");
    expect(within(drawer).queryByRole("note", { name: "Address not verified" })).toBeNull();
  });

  it("committed counts read as numbers until the Screens card's Edit; Save sends the change; a bad count shows the boxes", async () => {
    const { calls } = renderTab();
    const drawer = await openDrawer();
    const card = await within(drawer).findByRole("region", { name: "Screens: committed and installed" });
    expect(within(card).getByLabelText("Committed screens").textContent).toBe("2");
    expect(within(card).queryByRole("textbox")).toBeNull();
    await userEvent.click(within(card).getByRole("button", { name: "Edit committed counts" }));
    await userEvent.type(within(card).getByLabelText("TVs"), "x");
    await userEvent.click(within(card).getByRole("button", { name: "View committed counts" })); // the draft keeps "x"
    expect(within(card).queryByRole("textbox")).toBeNull();
    await userEvent.click(within(drawer).getByRole("button", { name: "Save details" }));
    // Invalid: nothing is sent and the card opens its boxes with the message.
    expect(await within(card).findByText("Store TVs (committed): must be a whole number of 0 or more")).toBeTruthy();
    expect(within(card).getByLabelText("TVs").getAttribute("aria-invalid")).toBe("true");
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
    await userEvent.clear(within(card).getByLabelText("TVs"));
    await userEvent.type(within(card).getByLabelText("TVs"), "1");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ committed_store_tvs: 1 }));
    await waitFor(() => expect(within(card).queryByRole("textbox")).toBeNull()); // saved: back to numbers
  });

  it("an unverified address offers Verify address, which saves Google's pin", async () => {
    const { calls } = renderTab({
      "GET /api/projects/p1/stores/u1": () => ({ ...STOPS[0], geocoded: "", needs_attention: ["address"] }),
      "GET /api/places/validate": () => ({
        ok: true, status: "OK", formatted: "1 Main St, Atlanta, GA 30303, USA", lat: 33.76, lng: -84.39,
        addr: "1 Main St", city: "Atlanta", state: "GA", zip: "30303", partial: false, suggestions: [], error: "",
      }),
    });
    const drawer = await openDrawer();
    expect(within(drawer).getByText(/not verified with Google/)).toBeTruthy();
    expect(within(drawer).queryByText(/re-optimise/)).toBeNull(); // not in a route: nothing to re-optimise
    await userEvent.click(within(drawer).getByRole("button", { name: "Verify address" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
      place: { lat: 33.76, lng: -84.39, formatted: "1 Main St, Atlanta, GA 30303, USA" },
    }));
  });


  it("store modal: address and screens left, details right, collapsible sections, read-only ExtID and PA, validation, tri-states, password, pictures", async () => {
    const { calls } = renderTab();
    const drawer = await openDrawer();
    const sections = within(drawer).getAllByRole("region", { hidden: true }).map((region) => region.getAttribute("aria-label"));
    expect(sections).toEqual([
      // Top: the screens (committed and installed together), the hardware cost, the mounts, and who is assigned.
      "Screens: committed and installed", "Hardware cost", "Mounts", "Assignment",
      // Left: what gets edited on site, the screens right under the address.
      "Identity & address", "Screens", "Screen list", "Notes", "Pictures", "Location",
      // Right: the other details.
      "WiFi", "Contacts", "Installation", "Site notes", "Site checklist", "Other imported data",
    ]);
    // The servicing history is not at the bottom of the details any more: it comes up under Logs.
    await userEvent.click(within(drawer).getByRole("tab", { name: "Logs" }));
    expect(await within(drawer).findByRole("region", { name: "Servicing history" })).toBeTruthy();
    expect(within(drawer).getByRole("region", { name: "Logs" })).toBeTruthy();
    await userEvent.click(within(drawer).getByRole("tab", { name: "Other details" }));
    const details = within(drawer).getByRole("complementary", { name: "Store details" });
    // Every section starts open, so the window reads top to bottom; each header still says what is inside. Notes
    // and Pictures are the exceptions: this store has none, so they start closed.
    const toggleOf = (name: string) => within(within(drawer).getByRole("region", { name })).getAllByRole("button", { expanded: undefined })[0]!;
    const everySection = ["Identity & address", "Screens", "Notes", "Pictures", "Location", "WiFi", "Contacts", "Installation", "Site notes", "Site checklist", "Other imported data"];
    const startClosed = ["Notes", "Pictures"];
    for (const name of everySection) expect(toggleOf(name).getAttribute("aria-expanded"), name).toBe(startClosed.includes(name) ? "false" : "true");
    // …and still collapses, one at a time or all at once.
    await userEvent.click(toggleOf("Contacts"));
    expect(toggleOf("Contacts").getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(within(drawer).getByRole("button", { name: "Expand all" }));
    expect(toggleOf("Contacts").getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(within(drawer).getByRole("button", { name: "Collapse all" }));
    for (const name of everySection) expect(toggleOf(name).getAttribute("aria-expanded"), name).toBe("false");
    await userEvent.click(within(drawer).getByRole("button", { name: "Expand all" }));
    expect(toggleOf("Contacts").textContent).toMatch(/Contacts(empty|\d+ of \d+ filled)$/);
    expect(toggleOf("Other imported data").textContent).toMatch(/Other imported data(empty|\d+ values?)$/);
    expect(toggleOf("Pictures").textContent).toBe("Picturesempty");
    // Every value is there, collapsed or not: opening a section only shows it.
    expect(within(within(details).getByRole("region", { name: "Contacts" })).getByLabelText("Store owner email").textContent).toBe("—");
    expect(within(details).queryByRole("textbox", { name: "Store owner email" })).toBeNull(); // not editing yet
    expect(within(drawer).getByLabelText("ExtID").textContent).toBe("IBC-1");
    // Address and screens read as text until their Edit is pressed.
    expect(within(drawer).queryByLabelText("Address *")).toBeNull();
    expect(within(drawer).getByLabelText("Address").textContent).toBe("1 Main St, Atlanta, GA 30303");
    expect(within(drawer).queryByRole("region", { name: "Screen rows" })).toBeNull();
    const screenTable = within(within(drawer).getByRole("region", { name: "Screen list" })).getByRole("table", { name: "Screens" });
    expect(within(screenTable).getByLabelText("Mount, screen 1").textContent).toBe("None"); // Wall, Ceiling or None
    expect(within(screenTable).getByText('24"')).toBeTruthy(); // a Dolphin screen is 24 inch
    expect(within(drawer).getByLabelText("PA").textContent).toContain("North"); // project fallback
    expect(within(drawer).queryByRole("textbox", { name: "ExtID" })).toBeNull();

    // Edit opens a section's fields; the one Save at the bottom validates everything before writing anything.
    expect(within(details).queryByRole("button", { name: /^Save / })).toBeNull(); // no per-section saves
    await userEvent.click(within(details).getByRole("button", { name: "Edit Contacts" }));
    await userEvent.type(within(details).getByRole("textbox", { name: "Store owner email" }), "nope");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save details" }));
    expect(await within(drawer).findByText("Store owner email: enter a valid email")).toBeTruthy();
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
    expect(within(details).getByRole("button", { name: "View Contacts" }).hasAttribute("disabled")).toBe(true); // fix it first
    await userEvent.clear(within(details).getByRole("textbox", { name: "Store owner email" }));
    await userEvent.click(within(details).getByRole("button", { name: "View Contacts" })); // back to lines, nothing undone
    expect(within(details).queryByRole("textbox", { name: "Store owner email" })).toBeNull();

    await userEvent.click(within(details).getByRole("button", { name: "Edit WiFi" }));
    const password = within(drawer).getByLabelText("Store SSID password") as HTMLInputElement;
    expect(password.type).toBe("password");
    await userEvent.click(within(drawer).getByRole("button", { name: "Show password" }));
    expect(password.type).toBe("text");

    await userEvent.click(within(details).getByRole("button", { name: "Edit Site checklist" }));
    await userEvent.click(within(drawer).getByRole("checkbox", { name: "Spot visible from most of store: Unknown" }));
    expect(within(drawer).getByRole("checkbox", { name: "Spot visible from most of store: Yes" })).toBeTruthy();
    await userEvent.click(within(drawer).getByRole("button", { name: "Edit Pictures" })); // on the left now
    await userEvent.type(within(drawer).getByLabelText("Pictures (image URL)"), "https://img.test/a.jpg https://img.test/b.jpg");
    await waitFor(() => expect(within(drawer).getAllByRole("img", { name: "Store picture" })).toHaveLength(2)); // previews
    // One Save sends every changed field together.
    await userEvent.click(within(drawer).getByRole("button", { name: "Save details" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ image_url: "https://img.test/a.jpg https://img.test/b.jpg", spot_visible: true }),
    );
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
  });

  it("drawer: screens editor adds, edits and deletes rows and saves them as a full replace", async () => {
    const { calls } = renderTab();
    const drawer = await openDrawer();
    await userEvent.click(within(drawer).getByRole("button", { name: "Edit Screens" }));
    const rows = within(drawer).getByRole("region", { name: "Screen rows" });
    expect(within(rows).getByTestId("derived-status").textContent).toBe("Upcoming");
    expect(within(rows).getByRole("button", { name: "Delete screen 1" }).hasAttribute("disabled")).toBe(true); // ≥ 1 row

    await userEvent.click(within(rows).getByRole("button", { name: "Add screen" }));
    const second = within(rows).getByRole("listitem", { name: "Screen 2" });
    // A new row asks for its size first; then it is a Dolphin screen unless told otherwise.
    expect(within(second).queryByRole("group", { name: "Owner of screen 2" })).toBeNull();
    await userEvent.click(within(second).getByRole("radio", { name: "55 inch" }));
    expect(within(second).getByRole("button", { name: "Dolphin" }).getAttribute("aria-pressed")).toBe("true");
    await userEvent.type(within(second).getByLabelText("DD code"), "V9");
    await userEvent.click(within(second).getByRole("button", { name: "Store" }));
    await userEvent.click(within(rows).getByRole("combobox", { name: "Status of screen 1" }));
    await userEvent.click(await screen.findByRole("option", { name: "Completed" }));
    expect(within(rows).getByTestId("derived-status").textContent).toBe("Upcoming"); // the new row is still Upcoming
    expect(within(rows).getByText(/2 screens · 1 Dolphin · 1 store TVs/)).toBeTruthy();

    await userEvent.click(within(rows).getByRole("button", { name: "Add screen" }));
    await userEvent.click(within(rows).getByRole("button", { name: "Delete screen 3" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete this screen?" }); // on top of the drawer
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete screen" }));
    expect(within(rows).queryByRole("listitem", { name: "Screen 3" })).toBeNull();

    await userEvent.click(within(drawer).getByRole("button", { name: "Save details" }));
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
    await userEvent.click(within(drawer).getByRole("button", { name: "Edit Screens" }));
    const rows = within(drawer).getByRole("region", { name: "Screen rows" });
    await userEvent.click(within(rows).getByRole("combobox", { name: "Status of screen 1" }));
    await userEvent.click(await screen.findByRole("option", { name: "Delivered" }));
    await userEvent.click(within(drawer).getByRole("button", { name: "Save details" }));
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
    await userEvent.click(within(drawer).getByRole("button", { name: "Edit Identity & address" }));
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
    await userEvent.click(within(drawer).getByRole("button", { name: "Edit Identity & address" }));
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

  it("shows each active filter as a chip that can be removed on its own, with Clear all", async () => {
    renderTab();
    await screen.findByText("Alpha Mart");
    expect(screen.queryByRole("group", { name: "Active filters" })).toBeNull(); // nothing filtered: no row
    await userEvent.click(within(screen.getByRole("group", { name: "Filters" })).getByRole("button", { name: "City" }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Decatur/ }));
    await userEvent.keyboard("{Escape}");
    await userEvent.type(screen.getByLabelText("Search stores"), "mart");
    const active = await screen.findByRole("group", { name: "Active filters" });
    await within(active).findByText("Search: mart");
    expect(within(active).getByText("City: Decatur")).toBeTruthy();
    await userEvent.click(within(active).getByRole("button", { name: "Remove City: Decatur" }));
    expect(within(active).queryByText("City: Decatur")).toBeNull();
    expect(within(active).getByText("Search: mart")).toBeTruthy(); // the other filter stays
    await userEvent.click(within(active).getByRole("button", { name: /Clear all/ }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Active filters" })).toBeNull());
    expect((screen.getByLabelText("Search stores") as HTMLInputElement).value).toBe("");
  });

  it("saves the manager's notes with the one Save, without touching details", async () => {
    const { calls } = renderTab();
    const drawer = await openDrawer();
    expect(within(drawer).queryByLabelText("Additional task done")).toBeNull();
    await userEvent.type(within(drawer).getByLabelText("Manager notes"), "Left a note");
    expect(calls.some((call) => call.url.pathname.endsWith("/progress"))).toBe(false); // nothing until Save
    await userEvent.click(within(drawer).getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(calls.filter((call) => call.url.pathname.endsWith("/progress")).length).toBe(1));
    expect(calls.find((call) => call.url.pathname.endsWith("/progress"))?.body).toEqual({ comment: "Left a note" });
    expect(calls.some((call) => call.method === "PATCH" && call.url.pathname === "/api/projects/p1/stores/u1")).toBe(false);
  });

  it("install type is a draft: the name comes back when switched back, and Save sends the self install", async () => {
    const { calls } = renderTab();
    const drawer = await openDrawer();
    const assignment = within(drawer).getByRole("region", { name: "Assignment" });
    const choose = async (name: string) => {
      await userEvent.click(within(assignment).getByRole("combobox", { name: "Install type" }));
      await userEvent.click(await screen.findByRole("option", { name }));
    };
    await userEvent.type(within(assignment).getByLabelText("Technician"), "Sai");
    await choose("Self install");
    expect(within(assignment).queryByLabelText("Technician")).toBeNull(); // the name box gives way to a pill
    expect(within(assignment).getByLabelText("Technician: self install")).toBeTruthy();
    await choose("Technician");
    expect((within(assignment).getByLabelText("Technician") as HTMLInputElement).value).toBe("Sai"); // not lost
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);

    await choose("Self install");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH" && !call.url.pathname.endsWith("/progress"))?.body).toEqual({
      install_type: "Self install",
    }));
    expect(calls.some((call) => call.url.pathname.endsWith("/progress"))).toBe(false); // no technician was saved
  });


  it("filter bar: STORE-MODEL §5 order, counts, greyed-out empties, and every filter reaches the list and map", async () => {
    const { calls } = renderTab();
    await screen.findByText("Alpha Mart");
    const bar = screen.getByRole("group", { name: "Filters" });
    expect(within(bar).getAllByRole("button").map((button) => button.textContent?.replace("no values", "").trim())).toEqual([
      "Status", "State", "City", "DMA", "DD Code", "Tag", "First Registration Date", "Last Registration Date",
      "More Filters", // the rest are in the More Filters panel
    ]);
    for (const name of ["DD Code (no values)"]) {
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
    const pins = [...calls].reverse().find((call) => call.url.pathname.endsWith("/overview"))?.url;
    expect(pins?.searchParams.getAll("city")).toEqual(["Decatur"]);
    const facets = [...calls].reverse().find((call) => call.url.pathname.endsWith("/overview"))?.url;
    expect(facets?.searchParams.getAll("city")).toEqual(["Decatur"]); // options are counted under the selection
    expect(within(bar).getByRole("button", { name: "City: Decatur" })).toBeTruthy();
  });

  it("Nearby sorts the table nearest first and adds a Distance column; another sort can still be picked", async () => {
    const { calls } = renderTab({
      "GET /api/projects/p1/stores": (url) => ({
        items: STOPS, next_cursor: null, total: 2, offset: 0,
        distances: url.searchParams.has("near_lat") ? { u1: 1.24, u2: 6.9 } : null,
      }),
    });
    await screen.findByText("Alpha Mart");
    expect(screen.queryByRole("columnheader", { name: /Distance/ })).toBeNull();
    expect(within(screen.getByRole("group", { name: "Map legend" }).parentElement!).getByRole("button", { name: "Nearby" })).toBeTruthy();
    act(() => useStoresUi.getState().setNear({ lat: 33.75, lng: -84.39, radius: 10, address: "1 Main St" }));
    await waitFor(() => expect(lastList(calls)?.searchParams.get("sort")).toBe("distance"));
    expect(lastList(calls)?.searchParams.get("radius_miles")).toBe("10");
    expect(await screen.findByText("1.2 mi")).toBeTruthy();
    expect(screen.getByText("6.9 mi")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /Distance/ }).getAttribute("aria-sort")).toBe("ascending");
    await userEvent.click(within(screen.getByRole("columnheader", { name: /Tag/ })).getByRole("button"));
    await waitFor(() => expect(lastList(calls)?.searchParams.get("sort")).toBe("tag"));
    act(() => useStoresUi.getState().setNear(null));
    await waitFor(() => expect(lastList(calls)?.searchParams.has("near_lat")).toBe(false));
    expect(screen.queryByRole("columnheader", { name: /Distance/ })).toBeNull();
  });

  it("status chips on top filter the table, the map and the chart together", async () => {
    const { calls } = renderTab();
    await screen.findByText("Alpha Mart");
    const chips = screen.getByRole("group", { name: "Status filter" });
    expect(within(chips).getByRole("button", { name: /Offline/ }).hasAttribute("disabled")).toBe(true); // none
    await userEvent.click(within(chips).getByRole("button", { name: /Online/ }));
    await waitFor(() => expect(lastList(calls)?.searchParams.getAll("bucket")).toEqual(["Completed"]));
    const last = (suffix: string) => [...calls].reverse().find((call) => call.url.pathname.endsWith(suffix))?.url;
    // The pins and the chart come with the same request, under the same filters.
    await waitFor(() => expect(last("/overview")?.searchParams.getAll("bucket")).toEqual(["Completed"]));
    expect(within(chips).getByRole("button", { name: /Online/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("top states here: every state in a scrolling panel, read only (filtering by state is on the full-page chart)", async () => {
    const states = ["TX", "FL", "OK", "IL", "MO", "TN", "PA", "CA", "GA", "KS", "LA", "MI"];
    const { calls } = renderTab({
      "GET /api/projects/p1/stores/by-state": () => states.map((state, index) => ({ state, count: 100 - index })),
    });
    await screen.findByText("Alpha Mart");
    const chart = await screen.findByRole("region", { name: "Top states by stores" });
    const listed = within(within(chart).getByRole("list", { name: "States" })).getAllByRole("listitem").map((item) => item.textContent);
    expect(listed).toHaveLength(12); // all of them
    expect(chart.parentElement?.className).toContain("overflow-y-auto"); // the panel scrolls when they don't fit
    expect(within(chart).queryByRole("button")).toBeNull(); // no state chips to click
    expect(within(chart).getByRole("link", { name: /Open chart in a new tab/ })).toBeTruthy();
    const byState = [...calls].reverse().find((call) => call.url.pathname.endsWith("/overview"))?.url;
    expect(byState?.searchParams.get("pending")).toBe("false"); // every status: the status chips decide
  });

  it("review notes sit under the store's notes, are saved with the rest, and have a filter of their own", async () => {
    const { calls } = renderTab({
      "GET /api/projects/p1/stores/filters": () => ({
        ...FILTER_OPTIONS, review: [{ value: "Has review notes", count: 1 }, { value: "No review notes", count: 2 }],
      }),
    });
    const drawer = await openDrawer();
    await userEvent.type(await within(drawer).findByLabelText(/Review notes/), "name not confirmed");
    await userEvent.click(within(drawer).getByRole("button", { name: /Save/ }));
    await waitFor(() =>
      expect(calls.find((call) => call.url.pathname.endsWith("/progress"))?.body).toEqual({ review_notes: "name not confirmed" }),
    );
    await userEvent.keyboard("{Escape}");
    await userEvent.click(await screen.findByRole("button", { name: "More Filters" }));
    await userEvent.click(await screen.findByRole("button", { name: "Work" })); // its section starts closed
    await userEvent.click(within(await screen.findByRole("group", { name: "Review Notes" })).getByRole("checkbox", { name: "Has review notes" }));
    await waitFor(() => expect(lastList(calls)?.searchParams.getAll("review")).toEqual(["Has review notes"]));
  });

  it("search also shows the screens waiting in Needs review, each with its Dolphin status", async () => {
    const waiting = {
      venue_id: "DD_HF94R6", key: "DD_HF94R6", date: "2026-11-24", status: "Offline", last_seen: "", offline_days: 3, serial_number: "SN-1",
      venue_name: "CMS_1", store_name: "Conoco - Muskogee", address: "1304 N York St, Muskogee, OK 74403", addr: "1304 N York St", city: "Muskogee",
      state: "OK", zip: "74403", lat: 35.7, lng: -95.3, pa_name: "IBC", external_id: "OK22245", dma: "", venue_type: "", first_registered: "",
      last_registered: "", snoozed_date: "",
    };
    const state = { pa: "IBC", snapshot_date: "2026-11-24", ingested_at: "", synced_at: "", matched_screens: 1, status_changes: 0, review_count: 1, not_reporting: 0, other_pa_count: 0 };
    const { calls } = renderTab({
      "GET /api/projects/p1": () => makeSummary({ device_pa: "IBC", device_sync: state }),
      "POST /api/projects/p1/device-sync": () => ({ synced: false, state, stores_updated: 0 }),
      "GET /api/projects/p1/device-sync/review": (url) =>
        url.searchParams.get("q") === "OK22245" ? { items: [waiting], next_cursor: null, total: 1, snoozed: 0 } : { items: [], next_cursor: null, total: 0, snoozed: 0 },
    });
    await screen.findByText("Alpha Mart");
    expect(screen.queryByRole("region", { name: "Matches in Needs review" })).toBeNull(); // nothing searched
    await userEvent.type(screen.getByRole("combobox", { name: "Search stores" }), "OK22245");
    const matches = await screen.findByRole("region", { name: "Matches in Needs review" });
    expect(matches.textContent).toContain("1 screen in Needs review matches");
    expect(matches.textContent).toContain("Needs reviewOfflineOK22245Conoco - MuskogeeDD_HF94R6");
    await userEvent.click(within(matches).getByRole("button", { name: "Show in Needs review" }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("Search the records to review") as HTMLInputElement).value).toBe("OK22245");
    expect(calls.some((call) => call.url.pathname.endsWith("/device-sync/review") && call.url.searchParams.get("limit") === "25" && call.url.searchParams.get("q") === "OK22245")).toBe(true);
  });

  it("a project that hides its hardware cost shows no cost column, chart or cost lines", async () => {
    renderTab();
    await screen.findByText("Alpha Mart");
    expect(screen.getByRole("columnheader", { name: "Hardware cost" })).toBeTruthy(); // shown unless hidden
    expect(screen.getByRole("region", { name: "Hardware cost" })).toBeTruthy();
  });

  it("…and with it hidden, none of them", async () => {
    renderTab({ "GET /api/projects/p1": () => makeSummary({ hardware_costs: { stick: 40, screens: [], mounts: [], hidden: true } }) });
    await screen.findByText("Alpha Mart");
    expect(screen.queryByRole("columnheader", { name: "Hardware cost" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Hardware cost" })).toBeNull();
    const drawer = await openDrawer();
    await within(drawer).findByRole("region", { name: "Screens: committed and installed" });
    expect(within(drawer).queryByLabelText("Hardware cost")).toBeNull();
    expect(within(drawer).queryByRole("region", { name: "Hardware cost" })).toBeNull(); // no card: three in the row
  });

  it("an admin deletes a store from its window after an 'Are you sure?' prompt", async () => {
    const { calls, db } = renderTab({
      "DELETE /api/projects/p1/stores/u1": () => {
        db.delete("u1");
        return undefined;
      },
    });
    const drawer = await openDrawer();
    await userEvent.click(await within(drawer).findByRole("button", { name: /Delete store/ }));
    const prompt = await screen.findByRole("dialog", { name: "Are you sure?" });
    expect(prompt.textContent).toContain("Alpha Mart");
    expect(calls.some((call) => call.method === "DELETE")).toBe(false); // nothing until confirmed

    await userEvent.click(within(prompt).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Are you sure?" })).toBeNull());
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);

    await userEvent.click(within(drawer).getByRole("button", { name: /Delete store/ }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Are you sure?" })).getByRole("button", { name: "Delete store" }));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.url.pathname === "/api/projects/p1/stores/u1")).toBe(true));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); // the store window closes too
    await waitFor(() => expect(screen.queryByText("IBC-1")).toBeNull()); // and the list no longer has it
  });
});

describe("StoresTab: one request for the map side", () => {
  it("asks for pins, filters, top states and hardware together, never one by one", async () => {
    const { calls } = renderTab();
    await screen.findByText("Alpha Mart");
    await waitFor(() => expect(calls.some((call) => call.url.pathname === "/api/projects/p1/stores/overview")).toBe(true));
    const separate = calls.filter((call) => /\/stores\/(pins|filters|by-state|hardware)$/.test(call.url.pathname));
    expect(separate).toEqual([]);
    const overview = calls.find((call) => call.url.pathname === "/api/projects/p1/stores/overview")!.url;
    expect(overview.searchParams.get("pending")).toBe("false"); // every status: the status chips decide
    expect(overview.searchParams.get("limit")).toBe("60"); // every state
  });
});
