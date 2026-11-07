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

  it("shows each day's driving time against the plan's limit", async () => {
    const bundle = makeBundle();
    bundle.plan.max_day_hours = 1;
    bundle.stops = bundle.stops.map((stop) => ({ ...stop, drive_minutes: stop.stop_uid === "c" ? 30 : 40 }));
    renderPlan(bundle);
    const today = await screen.findByRole("region", { name: "West, day 1" });
    const drive = within(today).getByLabelText("Driving time");
    expect(drive.textContent).toBe("≈ 1h 20m driving of 1h 00m max");
    expect(drive.className).toContain("text-amber-700"); // over the limit (e.g. after a manual reassign)
    const forecast = screen.getByRole("region", { name: "West, day 2" });
    expect(within(forecast).getByLabelText("Driving time").textContent).toBe("≈ 30m driving of 1h 00m max");
  });

  it("a started day keeps its own limits; forecast days use the plan's defaults", async () => {
    const bundle = makeBundle();
    bundle.plan.max_day_hours = 1;
    bundle.plan.days = [{ ...bundle.plan.days[0]!, max_day_hours: 2, stops_per_day: 6 }];
    bundle.stops = bundle.stops.map((stop) => ({ ...stop, drive_minutes: 40 }));
    renderPlan(bundle);
    const today = await screen.findByRole("region", { name: "West, day 1" });
    expect(within(today).getByLabelText("Driving time").textContent).toBe("≈ 1h 20m driving of 2h 00m max");
    expect(screen.getByText(/today 6\/day/).textContent).toContain("≤ 2 h driving");
    const forecast = screen.getByRole("region", { name: "West, day 2" });
    expect(within(forecast).getByLabelText("Driving time").textContent).toBe("≈ 40m driving of 1h 00m max");
  });

  it("plans the next day from the default starts", async () => {
    const api = renderPlan(makeBundle(), {
      "POST /api/route-plans/plan1/next-day": () =>
        makeBundle({ plan: makeRoutePlan({ days: [...makeRoutePlan().days, { number: 2, date: "2026-11-09", starts: {}, stops_per_day: null, max_day_hours: null }] }) }),
    });
    await userEvent.click(await screen.findByRole("button", { name: /Plan next day/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/2 of its 3 stops were not visited/)).toBeTruthy();
    expect((within(dialog).getByLabelText("Date") as HTMLInputElement).value).toBe("2026-11-09"); // Friday → Monday
    expect((within(dialog).getByLabelText("Next start for West") as HTMLInputElement).value).toBe("a Main St, Atlanta, GA 30303");
    await userEvent.click(within(dialog).getByRole("button", { name: /Recalculate and plan day 2/ }));
    await waitFor(() => expect(api.calls.some((call) => call.url.pathname.endsWith("/next-day"))).toBe(true));
    const body = api.calls.find((call) => call.url.pathname.endsWith("/next-day"))!.body as Record<string, unknown>;
    expect(body).toMatchObject({ date: "2026-11-09", stops_per_day: 10, max_day_hours: 0, version: 3 });
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

  it("edit mode: move a store to the next day, and lock a day", async () => {
    let current = makeBundle();
    const api = renderPlan(current, {
      "GET /api/route-plans/plan1": () => current,
      "POST /api/route-plans/plan1/stops/p1/b/next-day": () => current,
      "POST /api/route-plans/plan1/days/lock": () => {
        current = makeBundle({ plan: makeRoutePlan({ locked_days: [{ installer: "West", day: 2 }] }) });
        return current;
      },
    });
    const today = await screen.findByRole("region", { name: "West, day 1" });
    expect(within(today).queryByRole("button", { name: /Move Store b to the next day/ })).toBeNull(); // only in edit mode
    await userEvent.click(within(today).getByRole("button", { name: "Edit West, day 1" }));
    expect(within(today).queryByRole("button", { name: /Move Store a/ })).toBeNull(); // visited
    await userEvent.click(within(today).getByRole("button", { name: "Move Store b to the next day" }));
    await waitFor(() => expect(api.calls.some((call) => call.url.pathname.endsWith("/b/next-day"))).toBe(true));
    expect(api.calls.find((call) => call.url.pathname.endsWith("/b/next-day"))!.body).toEqual({ version: 3 });

    await userEvent.click(screen.getByRole("button", { name: "Lock West, day 2" }));
    await waitFor(() => expect(api.calls.some((call) => call.url.pathname.endsWith("/days/lock"))).toBe(true));
    expect(api.calls.find((call) => call.url.pathname.endsWith("/days/lock"))!.body).toEqual({ installer: "West", day: 2, locked: true, version: 3 });
    const locked = await screen.findByRole("region", { name: "West, day 2" });
    expect(await within(locked).findByText("Locked")).toBeTruthy();
    expect(within(locked).getByRole("button", { name: "Unlock West, day 2" })).toBeTruthy();
  });

  it("adds a store from another day where chosen, showing each place between two stores", async () => {
    const api = renderPlan(makeBundle(), {
      "POST /api/route-plans/plan1/days/insert-options": () => ({
        store_name: "Store d",
        options: [
          { position: 0, after: "", before: "Store c", extra_minutes: 25, best: false },
          { position: 1, after: "Store c", before: "", extra_minutes: 10, best: true },
        ],
      }),
      "POST /api/route-plans/plan1/days/insert": () => makeBundle(),
    });
    const day2 = await screen.findByRole("region", { name: "West, day 2" });
    await userEvent.click(within(day2).getByRole("button", { name: "Edit West, day 2" }));
    await userEvent.click(within(day2).getByRole("button", { name: /Add store to this day/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText("Store a")).toBeNull(); // visited
    expect(within(dialog).queryByText("Store c")).toBeNull(); // already on this day
    await userEvent.click(within(dialog).getByText("Store d"));
    const best = await within(dialog).findByRole("radio", { checked: true });
    expect(best.closest("label")!.textContent).toContain("Store c→Store d→End of day");
    expect(best.closest("label")!.textContent).toContain("Best");
    expect(within(dialog).getByText("+25m")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: /Add here/ }));
    await waitFor(() => expect(api.calls.some((call) => call.url.pathname.endsWith("/days/insert"))).toBe(true));
    expect(api.calls.find((call) => call.url.pathname.endsWith("/days/insert"))!.body).toEqual({
      installer: "West", day: 2, position: 1, store: { project_id: "p1", stop_uid: "d" }, version: 3,
    });
  });

  it("a closed plan is read only", async () => {
    renderPlan(makeBundle({ plan: makeRoutePlan({ status: "closed" }) }));
    expect(await screen.findByText("(closed)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Plan next day/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Log visit/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit West/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Lock West/ })).toBeNull();
  });
});
