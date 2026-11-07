import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanWizard } from "@/features/planner/PlanWizard";
import { mockApi, renderWithProviders } from "@/test/render";
import { makeBundle, makePlanStop, makePoolStore } from "@/test/planFixtures";

const POOL = [makePoolStore("a"), makePoolStore("b", { city: "Decatur" }), makePoolStore("c", { route_plan_id: "other" })];

afterEach(() => vi.restoreAllMocks());

describe("PlanWizard", () => {
  it("stores → installers with a start → days → preview → create", async () => {
    const api = mockApi({
      "GET /api/store-search/pins": () => POOL,
      "GET /api/store-search/facets": () => ({ states: [{ value: "GA", count: 3, label: "" }], cities: [], projects: [] }),
      "GET /api/config/maps": () => ({ google_maps_browser_key: "" }),
      "GET /api/lists/installers": () => ({ items: [{ value: "Ann", created_at: "" }], next_cursor: null }),
      "POST /api/route-plans/preview": () => ({ stops: [makePlanStop("a", { installer: "Ann" }), makePlanStop("b", { installer: "Ann", seq: 1 })], skipped: [] }),
      "POST /api/route-plans": () => ({ bundle: makeBundle(), skipped: [] }),
    });
    renderWithProviders(<PlanWizard />, { path: "/planner/new", route: "/planner/new" });

    expect(await screen.findByText(/3 matching · 0 selected · 1 in a plan/)).toBeTruthy();
    expect(screen.getByLabelText("In another plan")).toBeTruthy(); // locked, no checkbox
    await userEvent.click(screen.getByRole("button", { name: "Select all 2 matching" }));
    expect(screen.getByText(/2 selected/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));

    await userEvent.type(screen.getByLabelText("Installer 1 name"), "Ann");
    expect(screen.getByRole("button", { name: /Next/ }).hasAttribute("disabled")).toBe(true); // no start yet
    await userEvent.type(screen.getByLabelText("Starting location for installer 1"), "33.75, -84.39{Enter}");
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));

    await userEvent.clear(screen.getByLabelText(/Stops per day/));
    await userEvent.type(screen.getByLabelText(/Stops per day/), "12");
    await userEvent.type(screen.getByLabelText(/Max driving per day/), "30");
    expect(screen.getByText(/Between 0 and 24 hours/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Next/ }).hasAttribute("disabled")).toBe(true);
    await userEvent.clear(screen.getByLabelText(/Max driving per day/));
    await userEvent.type(screen.getByLabelText(/Max driving per day/), "6.5");
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));

    expect(await screen.findByRole("region", { name: "Ann preview" })).toBeTruthy();
    expect(screen.getByText(/Day 1: 2 stops/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Create plan/ }));
    await waitFor(() => expect(screen.getByTestId("navigated")).toBeTruthy());
    const created = api.calls.find((call) => call.method === "POST" && call.url.pathname === "/api/route-plans")!.body as Record<string, unknown>;
    expect(created).toMatchObject({
      stops_per_day: 12,
      max_day_hours: 6.5,
      installers: [{ name: "Ann", start: { address: "33.75, -84.39", lat: 33.75, lng: -84.39 } }],
      stores: [{ project_id: "p1", stop_uid: "a" }, { project_id: "p1", stop_uid: "b" }],
    });
    expect(created.name).toMatch(/^GA · \d{4}-\d{2}-\d{2}$/);
  });
});
