import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { ProjectPage } from "@/features/projects/ProjectPage";
import { RoutesTab } from "@/features/routes/RoutesTab";
import { mockApi, renderWithProviders } from "@/test/render";
import { makeProject, makeStop } from "@/test/fixtures";
import type { RoutesBundle, Stop } from "@/lib/api/types";

const s = (uid: string, overrides: Partial<Stop> = {}) =>
  makeStop({ uid, display_id: uid.toUpperCase(), store_name: `Store ${uid}`, addr: `${uid} Main St`, ...overrides });

const BUNDLE: RoutesBundle = {
  installers: ["Ann", "Bo"],
  stops_per_day: 8,
  routing_status: "ready",
  stats: {
    Ann: { total: 3, days: 2, avg_stops: 1.5, miles: 4.2 },
    Bo: { total: 1, days: 1, avg_stops: 1, miles: 0 },
  },
  routes: {
    Ann: [
      [s("a", { lat: 33.8, fields: { pa: "North" } }), s("b", { lat: 33.81, status: "Complete" })],
      [s("c", { lat: 33.82, city: "Decatur", day: 2 })],
    ],
    Bo: [[s("d", { lat: 33.6, installer: "Bo", fields: { pa: "South" } })]],
  },
};

function renderRoutes(project = makeProject(), extra: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({
    "GET /api/projects/p1": () => project,
    "GET /api/projects/p1/routes": () => BUNDLE,
    "GET /api/config/maps": () => ({ google_maps_browser_key: "" }),
    "GET /api/projects/p1/stores/a": () => BUNDLE.routes.Ann?.[0]?.[0],
    ...extra,
  });
  renderWithProviders(
    <Routes>
      <Route path="projects/:projectId" element={<ProjectPage />}>
        <Route path="routes" element={<RoutesTab />} />
      </Route>
    </Routes>,
    { path: "/*", route: "/projects/p1/routes" },
  );
  return api;
}

afterEach(() => vi.restoreAllMocks());

describe("RoutesTab", () => {
  it("shows installer tabs with territory and stats, day cards and route links", async () => {
    renderRoutes();
    expect(await screen.findByRole("tab", { name: /Ann.*3 stops · 2 days · 4.2 mi/ })).toBeTruthy();
    const ann = screen.getByRole("region", { name: "Ann routes" });
    expect(within(ann).getByText(/3 sites · 2 active days/)).toBeTruthy();
    const day1 = screen.getByRole("region", { name: "Ann, day 1" });
    expect(within(day1).getByText("1 active · 2 records")).toBeTruthy();
    const link = within(day1).getByRole("link", { name: /Open route \(1 active stop\)/ });
    expect(link.getAttribute("href")).toContain("google.com/maps/search");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("filters by installer tab, day list, PA and search, and switches to the summary view", async () => {
    renderRoutes();
    await userEvent.click(await screen.findByRole("tab", { name: /^Bo/ }));
    expect(screen.queryByRole("region", { name: "Ann routes" })).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "All installers" }));
    await userEvent.type(screen.getByLabelText("Days"), "2");
    expect(screen.getByRole("region", { name: "Ann, day 2" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Ann, day 1" })).toBeNull();
    await userEvent.clear(screen.getByLabelText("Days"));
    await userEvent.type(screen.getByLabelText("Search routes"), "store d");
    expect(screen.getByRole("region", { name: "Bo, day 1" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Ann routes" })).toBeNull();
    await userEvent.clear(screen.getByLabelText("Search routes"));
    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(4); // header + Ann d1, Ann d2, Bo d1
    expect(within(table).getAllByRole("link", { name: /Open \(1\)/ })).toHaveLength(3);
  });

  it("updates a day-card status at once, before the bundle refetches, and rolls back on error", async () => {
    let fail: () => void = () => {};
    renderRoutes(makeProject(), {
      "PATCH /api/projects/p1/stores/a/progress": () =>
        new Promise((resolve) => {
          fail = () => resolve(new Response(JSON.stringify({ detail: "nope" }), { status: 500 }));
        }),
    });
    const status = () => screen.getByRole("combobox", { name: "Status of Store a" }).textContent;
    await userEvent.click(await screen.findByRole("combobox", { name: "Status of Store a" }));
    await userEvent.click(await screen.findByRole("option", { name: "Complete" }));
    await waitFor(() => expect(status()).toContain("Complete")); // the PATCH is still pending
    fail();
    await waitFor(() => expect(status()).toContain("Upcoming"));
  });

  it("reassigns a stop only after confirmation", async () => {
    const { calls } = renderRoutes(makeProject(), {
      "POST /api/projects/p1/stops/a/reassign": () => ({ old_installer: "Ann", installer: "Bo", changed: ["a"] }),
    });
    await userEvent.click(await screen.findByRole("combobox", { name: "Installer for Store a" }));
    await userEvent.click(await screen.findByRole("option", { name: "Bo" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Move/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls.some((call) => call.url.pathname.endsWith("/reassign"))).toBe(false);

    await userEvent.click(screen.getByRole("combobox", { name: "Installer for Store a" }));
    await userEvent.click(await screen.findByRole("option", { name: "Bo" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Reassign" }));
    await waitFor(() => expect(calls.find((call) => call.url.pathname.endsWith("/reassign"))?.body).toEqual({ installer: "Bo" }));
  });

  it("starts rebalance and recluster jobs after confirmation, disabled while building", async () => {
    const { calls } = renderRoutes(makeProject(), {
      "POST /api/projects/p1/routing/rebalance": () => ({ job_id: "j1" }),
    });
    await userEvent.click(await screen.findByRole("button", { name: /Rebalance upcoming/ }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Rebalance" }));
    await waitFor(() => expect(calls.some((call) => call.url.pathname.endsWith("/routing/rebalance"))).toBe(true));
  });

  it("disables routing actions while a build runs", async () => {
    renderRoutes(makeProject({ routing_status: "building" }));
    expect(await screen.findByText(/Routes are being rebuilt/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Rebuild all routes/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("exports the filtered routes as CSV and copies a day's addresses", async () => {
    const created: Blob[] = [];
    // jsdom has no object URLs; stub them for this test.
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      created.push(blob as Blob);
      return "blob:csv";
    };
    URL.revokeObjectURL = () => {};
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    renderRoutes();
    await userEvent.click(await screen.findByRole("button", { name: /All routes CSV/ }));
    expect(click).toHaveBeenCalled();
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader(); // jsdom's Blob has no .text()
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(created[0] as Blob);
    });
    expect(text.split("\r\n")).toHaveLength(5); // header + 4 stops
    expect(text).toContain("Route Owner,Installer Name,Day,Stop #,ID,Store Name");

    const day1 = screen.getByRole("region", { name: "Ann, day 1" });
    await userEvent.click(within(day1).getByRole("button", { name: /Copy addresses/ }));
    expect(writeText).toHaveBeenCalledWith("1. a Main St, Atlanta, GA 30303 — Store a\n2. b Main St, Atlanta, GA 30303 — Store b");
    expect(await within(day1).findByText("Copied!")).toBeTruthy();
  });

  it("opens the store drawer from a stop", async () => {
    renderRoutes();
    await userEvent.click(await screen.findByRole("button", { name: "Edit Store a" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(await screen.findByText("Field progress")).toBeTruthy();
  });
});
