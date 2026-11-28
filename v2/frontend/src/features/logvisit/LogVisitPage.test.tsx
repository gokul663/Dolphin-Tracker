import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router";
import { AppShell } from "@/app/layout/AppShell";
import { LogVisitPage } from "@/features/logvisit/LogVisitPage";
import { makeKpi, makeProject, makeScreen, makeStop } from "@/test/fixtures";
import { mockApi, renderWithProviders } from "@/test/render";
import { STORE_FIELDS_FOR_TESTS } from "@/test/storeFields";
import type { Role, VisitSearchRow } from "@/lib/api/types";

vi.mock("@/lib/auth/token", async (original) => ({ ...(await original<typeof import("@/lib/auth/token")>()), profilePicture: vi.fn(async () => "") }));

const ROW: VisitSearchRow = {
  project_id: "p1",
  project_name: "Alpha",
  uid: "u1",
  display_id: "",
  external_id: "EXT-77",
  store_name: "Joe's Market",
  addr: "12 Main St",
  city: "Atlanta",
  state: "GA",
  zip: "30303",
  status: "Offline",
  screens: [
    { id: "s1", stick_number: "ST-1", venue_id: "DD_ABC123", status: "Offline" },
    { id: "s2", stick_number: "ST-2", venue_id: "DD_XYZ999", status: "Completed" },
  ],
  matched_on: ["dd_code"],
  matched_screen_ids: ["s1"],
};

function Where() {
  return <output aria-label="Address bar">{useLocation().search}</output>;
}

function renderPage(route = "/log-visit", total = 1) {
  const api = mockApi({
    "GET /api/visit-search": (url) => (url.searchParams.get("q") === "nothing" ? { items: [], total: 0 } : { items: [ROW], total }),
    "GET /api/projects/p1": () => ({ kpi: makeKpi(), ...makeProject() }),
    "GET /api/projects/p1/stores/u1": () => makeStop({ uid: "u1", store_name: "Joe's Market", screens: [makeScreen({ id: "s1", venue_id: "DD_ABC123" })] }),
    "GET /api/config/store-fields": () => STORE_FIELDS_FOR_TESTS,
    "GET /api/lists/categories": () => [],
    "GET /api/lists/installers": () => ({ items: [], next_cursor: null }),
    "GET /api/lists/managers": () => ({ items: [], next_cursor: null }),
    "GET /api/projects/p1/stores/u1/visits": () => ({ items: [], next_cursor: null }),
    "GET /api/projects/p1/stores/u1/comments": () => ({ items: [], next_cursor: null }),
    "GET /api/config/maps": () => ({ google_maps_browser_key: "" }),
  });
  renderWithProviders(
    <>
      <LogVisitPage />
      <Where />
    </>,
    { path: "/log-visit", route, role: "operator" },
  );
  return api;
}

const searches = (api: ReturnType<typeof mockApi>) => api.calls.filter((call) => call.url.pathname === "/api/visit-search");

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("LogVisitPage", () => {
  it("says what can be searched, then searches after a pause and picks out the matching DD code", async () => {
    const api = renderPage();
    expect(screen.getByText(/a screen's DD code/)).toBeTruthy();
    const box = screen.getByRole("searchbox", { name: "Search stores" });
    expect(document.activeElement).toBe(box);
    await userEvent.type(box, "a");
    expect(searches(api)).toHaveLength(0); // one character is not a search
    await userEvent.type(box, "bc12");
    const list = await screen.findByRole("list", { name: "Stores found" });
    expect(searches(api).map((call) => call.url.searchParams.get("q"))).toEqual(["abc12"]); // once, after the pause
    expect(within(list).getByText("Joe's Market")).toBeTruthy();
    expect(within(list).getByText("Alpha")).toBeTruthy();
    expect(within(list).getByText("12 Main St, Atlanta, GA 30303")).toBeTruthy();
    const mark = within(list).getByText("DD_ABC123");
    expect(mark.tagName).toBe("MARK");
    expect(within(list).getByText("DD_XYZ999").tagName).not.toBe("MARK");
    expect(screen.getByLabelText("Address bar").textContent).toBe("?q=abc12");
  });

  it("reads the search from the address bar, and opens the visit dialog with Enter", async () => {
    const api = renderPage("/log-visit?q=DD_ABC123");
    expect((screen.getByRole("searchbox", { name: "Search stores" }) as HTMLInputElement).value).toBe("DD_ABC123");
    const row = await screen.findByRole("button", { name: /Log a visit to Joe's Market \(EXT-77\), Alpha/ });
    row.focus();
    await userEvent.keyboard("{Enter}");
    // The route planner's store window, without a plan: the screens bar and Details / Logs, no plan chip or actions.
    const dialog = await screen.findByRole("dialog", { name: "Joe's Market" });
    expect(within(dialog).getByRole("tablist", { name: "Screens of this store" })).toBeTruthy();
    expect(within(dialog).getByRole("tab", { name: "Details" })).toBeTruthy();
    expect(within(dialog).queryByLabelText("Stop in the plan")).toBeNull();
    expect(within(dialog).queryByRole("group", { name: "Plan actions" })).toBeNull();
    // An Operator, and this store is on no route: the visit can be logged, the screen's details are read only.
    expect(within(dialog).getByText(/This store is not on a route/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /Save log entry/ })).toBeTruthy();
    await waitFor(() => expect(api.calls.some((call) => call.url.pathname === "/api/projects/p1/stores/u1")).toBe(true));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: /Log a visit to Joe's Market/ })).toBeTruthy(); // the results stay
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("DD_ABC123");
  });

  it("says plainly when nothing matches", async () => {
    renderPage("/log-visit?q=nothing");
    expect(await screen.findByText(/No store matches “nothing”/)).toBeTruthy();
  });

  it("asks to refine when only the top stores are shown, and clears", async () => {
    renderPage("/log-visit?q=main", 40);
    expect(await screen.findByText("Top 1 of 40 stores")).toBeTruthy();
    expect(screen.getByText(/Refine your search/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
    expect(screen.getByLabelText("Address bar").textContent).toBe("");
    expect(screen.queryByRole("list", { name: "Stores found" })).toBeNull();
  });
});

describe("Log Visit in the top navigation", () => {
  function renderShell(role: Role) {
    mockApi({ "GET /api/health": () => ({ status: "ok", env: "test", db: true, ts: "" }) });
    renderWithProviders(
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<p>home</p>} />
        </Route>
      </Routes>,
      { path: "/*", role },
    );
  }

  it.each([
    ["operator", true],
    ["admin", true],
    ["viewer", false],
  ] as const)("for a %s: shown %s", (role, shown) => {
    renderShell(role);
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(Boolean(within(nav).queryByRole("link", { name: "Log Visit" }))).toBe(shown);
    expect(within(nav).getByRole("link", { name: "Installers" })).toBeTruthy();
  });
});
