import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
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
      "GET /api/store-search/facets": () => ({ states: [{ value: "GA", count: 3, label: "" }], cities: [], projects: [], dmas: [{ value: "Atlanta", count: 3, label: "" }], statuses: [], buckets: [{ value: "Upcoming", count: 3, label: "" }, { value: "Completed", count: 0, label: "" }] }),
      "GET /api/config/maps": () => ({ google_maps_browser_key: "" }),
      "GET /api/lists/installers": () => ({ items: [{ value: "Ann", created_at: "", phone: "555 010 2000", email: "" }], next_cursor: null }),
      "POST /api/route-plans/preview": () => ({ stops: [makePlanStop("a", { installer: "Ann" }), makePlanStop("b", { installer: "Ann", seq: 1 })], skipped: [] }),
      "POST /api/route-plans": () => ({ bundle: makeBundle(), skipped: [] }),
    });
    renderWithProviders(<PlanWizard />, { path: "/planner/new", route: "/planner/new" });

    expect(await screen.findByText(/3 matching · 0 selected · 1 in a plan/)).toBeTruthy();
    // Starts from the Upcoming group: the Projects page's status chips, filters and "Filtered by" chips.
    expect(new URL(api.calls.find((call) => call.url.pathname === "/api/store-search/pins")!.url).searchParams.getAll("bucket")).toEqual(["Upcoming"]);
    const filters = screen.getByRole("group", { name: "Store filters" });
    expect(within(filters).getByRole("button", { name: /Upcoming\s*3/ }).getAttribute("aria-pressed")).toBe("true");
    expect(within(filters).getByRole("button", { name: /Online/ })).toBeTruthy();
    await userEvent.click(within(filters).getByRole("button", { name: "Remove Status: Upcoming" }));
    await waitFor(() => expect(within(filters).queryByRole("group", { name: "Active filters" })).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "DMA" }));
    await userEvent.type(await screen.findByLabelText("Search DMA"), "zzz");
    expect(screen.getByText("No match")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByLabelText("In another plan")).toBeTruthy(); // locked, no checkbox
    await userEvent.click(screen.getByRole("button", { name: "Select all 2 matching" }));
    expect(screen.getByText(/2 selected/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));

    // The installer is picked from the Installers page's list; the start is looked up without a button.
    expect(screen.getByRole("button", { name: /Next/ }).hasAttribute("disabled")).toBe(true); // nobody added yet
    await userEvent.click(screen.getByRole("combobox", { name: "Installer" }));
    await userEvent.click(await screen.findByRole("option", { name: "Ann" }));
    expect(screen.getByText("555 010 2000")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Add installer" }));
    expect(screen.getByRole("alert").textContent).toMatch(/starting location/); // no start yet
    await userEvent.type(screen.getByLabelText("Starting location for Ann"), "33.75, -84.39{Enter}");
    expect(screen.getByRole("status").textContent).toContain("33.75000, -84.39000");
    await userEvent.clear(screen.getByLabelText("Stops per day"));
    await userEvent.type(screen.getByLabelText("Stops per day"), "12");
    await userEvent.type(screen.getByLabelText(/Max driving per day/), "30");
    expect(screen.getByText(/Between 0 and 24 hours/)).toBeTruthy();
    await userEvent.clear(screen.getByLabelText(/Max driving per day/));
    await userEvent.type(screen.getByLabelText(/Max driving per day/), "6.5");
    // Each installer has their own start date; the plan's first day is the earliest.
    await userEvent.clear(screen.getByLabelText("Start date"));
    await userEvent.type(screen.getByLabelText("Start date"), "2026-12-01");
    await userEvent.click(screen.getByRole("button", { name: "Add installer" }));
    // Added: a line with what was entered, and Edit / Remove on it.
    const line = within(screen.getByRole("list", { name: "Installers on this plan" })).getByRole("listitem", { name: "Ann" });
    expect(line.textContent).toContain("starts 2026-12-01 · 12 stops/day · max 6.5 h driving");
    await userEvent.type(screen.getByLabelText("Plan name"), "Texas run"); // on this step: two steps, then the preview
    expect(screen.getByRole("list", { name: "Steps" }).textContent).toBe("1. Stores2. Installers3. Preview");
    expect(within(line).getByRole("button", { name: "Edit Ann" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));


    const ann = await screen.findByRole("region", { name: "Ann preview" });
    expect(within(ann).getByText("Store a")).toBeTruthy(); // the stores of each day, in order
    const day = within(ann).getByRole("button", { name: /Day 1: 2 stops/ });
    expect(screen.getByText("Showing every installer and day.")).toBeTruthy();
    await userEvent.click(day);
    expect(day.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/Showing Ann, day 1/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Create plan/ }));
    await waitFor(() => expect(screen.getByTestId("navigated")).toBeTruthy());
    const created = api.calls.find((call) => call.method === "POST" && call.url.pathname === "/api/route-plans")!.body as Record<string, unknown>;
    expect(created).toMatchObject({
      installers: [{ name: "Ann", start: { address: "33.75, -84.39", lat: 33.75, lng: -84.39 }, stops_per_day: 12, max_day_hours: 6.5, start_date: "2026-12-01" }],
      start_date: "2026-12-01",
      name: "Texas run",
      stores: [{ project_id: "p1", stop_uid: "a" }, { project_id: "p1", stop_uid: "b" }],
    });
  });
});
