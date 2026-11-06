import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanPage } from "@/features/planner/PlanPage";
import { mockApi, renderWithProviders } from "@/test/render";
import { makeBundle, makeRoutePlan } from "@/test/planFixtures";

function renderPlan(bundle = makeBundle(), extra: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({
    "GET /api/route-plans/plan1": () => bundle,
    "GET /api/config/maps": () => ({ google_maps_browser_key: "" }),
    ...extra,
  });
  renderWithProviders(<PlanPage />, { path: "/planner/:planId", route: "/planner/plan1" });
  return api;
}

afterEach(() => vi.restoreAllMocks());

describe("PlanPage", () => {
  it("shows installers, today and forecast days, visit state and live status", async () => {
    renderPlan();
    expect(await screen.findByRole("heading", { name: /GA week/ })).toBeTruthy();
    expect(screen.getByText(/1 of 4 stores visited · 3 open/)).toBeTruthy();
    expect(screen.getByRole("tab", { name: /West.*1\/3 visited · 2 days/ })).toBeTruthy();
    const today = screen.getByRole("region", { name: "West, day 1" });
    expect(within(today).getByText("Today")).toBeTruthy();
    expect(within(today).getByText("Visited")).toBeTruthy();
    expect(within(today).getByText("Offline")).toBeTruthy(); // store b's live status
    const forecast = screen.getByRole("region", { name: "West, day 2" });
    expect(within(forecast).getByText("Forecast")).toBeTruthy();
    expect(within(today).getByRole("link", { name: /Open route in Google Maps/ }).getAttribute("href")).toContain(
      encodeURIComponent("West depot, GA"),
    );
  });

  it("plans the next day from the default starts", async () => {
    const api = renderPlan(makeBundle(), {
      "POST /api/route-plans/plan1/next-day": () =>
        makeBundle({ plan: makeRoutePlan({ days: [...makeRoutePlan().days, { number: 2, date: "2026-11-09", starts: {} }] }) }),
    });
    await userEvent.click(await screen.findByRole("button", { name: /Plan next day/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/2 of its 3 stops were not visited/)).toBeTruthy();
    expect((within(dialog).getByLabelText("Date") as HTMLInputElement).value).toBe("2026-11-09"); // Friday → Monday
    expect((within(dialog).getByLabelText("Next start for West") as HTMLInputElement).value).toBe("a Main St, Atlanta, GA 30303");
    await userEvent.click(within(dialog).getByRole("button", { name: /Recalculate and plan day 2/ }));
    await waitFor(() => expect(api.calls.some((call) => call.url.pathname.endsWith("/next-day"))).toBe(true));
    const body = api.calls.find((call) => call.url.pathname.endsWith("/next-day"))!.body as Record<string, unknown>;
    expect(body).toMatchObject({ date: "2026-11-09", stops_per_day: 10, version: 3 });
    expect((body.starts as Record<string, { lat: number }>).West!.lat).toBe(33.7);
  });

  it("reassigns an open stop after confirming", async () => {
    const api = renderPlan(makeBundle(), {
      "POST /api/route-plans/plan1/stops/p1/b/reassign": () => makeBundle(),
    });
    await userEvent.click(await screen.findByRole("combobox", { name: "Installer for Store b" }));
    await userEvent.click(await screen.findByRole("option", { name: "East" }));
    await userEvent.click(await screen.findByRole("button", { name: "Reassign" }));
    await waitFor(() => expect(api.calls.some((call) => call.url.pathname.endsWith("/reassign"))).toBe(true));
    expect(api.calls.find((call) => call.url.pathname.endsWith("/reassign"))!.body).toEqual({ installer: "East", version: 3 });
  });

  it("a closed plan is read only", async () => {
    renderPlan(makeBundle({ plan: makeRoutePlan({ status: "closed" }) }));
    expect(await screen.findByText("(closed)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Plan next day/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Log visit/ })).toBeNull();
  });
});
