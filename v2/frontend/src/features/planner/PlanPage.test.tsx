import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanPage } from "@/features/planner/PlanPage";
import { mockApi, renderWithProviders } from "@/test/render";
import { makeBundle, makePlanStop, makeRoutePlan } from "@/test/planFixtures";
import type { Role } from "@/lib/api/types";

function renderPlan(bundle = makeBundle(), extra: Parameters<typeof mockApi>[0] = {}, role: Role = "super_admin") {
  const api = mockApi({
    "GET /api/route-plans/plan1": () => bundle,
    "GET /api/config/maps": () => ({ google_maps_browser_key: "" }),
    ...extra,
  });
  renderWithProviders(<PlanPage />, { path: "/planner/:planId", route: "/planner/plan1", role });
  return api;
}

afterEach(() => vi.restoreAllMocks());

describe("PlanPage", () => {
  it("shows installers, today and forecast days, visit state and live status", async () => {
    renderPlan();
    expect(await screen.findByRole("heading", { name: /GA week/ })).toBeTruthy();
    expect(screen.getByText(/1 of 4 stores done · 3 open/)).toBeTruthy();
    expect(screen.getByRole("tab", { name: /West.*1\/3 done · 2 days/ })).toBeTruthy();
    const today = screen.getByRole("region", { name: "West, day 1" });
    expect(within(today).getByText("Today")).toBeTruthy();
    expect(within(today).getByText("Done")).toBeTruthy(); // store a: its stick has a log entry
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
    // Limits left blank: every installer keeps their own.
    expect(body).toMatchObject({ date: "2026-11-09", stops_per_day: null, max_day_hours: null, version: 3 });
    expect((body.starts as Record<string, { lat: number }>).West!.lat).toBe(33.7);
  });

  it("a stop is marked Done, Incomplete or In route; the summary counts them and lists their stores", async () => {
    let current = makeBundle();
    const api = renderPlan(current, {
      "GET /api/route-plans/plan1": () => current,
      "POST /api/route-plans/plan1/stops/p1/b/mark": () => {
        current = makeBundle();
        current.stops = current.stops.map((stop) => (stop.stop_uid === "b" ? { ...stop, outcome: "incomplete" as const } : stop));
        return current;
      },
    });
    const summary = await screen.findByRole("region", { name: "Plan summary" });
    expect(within(summary).getByRole("button", { name: /Done 1/ })).toBeTruthy();
    expect(within(summary).getByRole("button", { name: /In route 3/ })).toBeTruthy();
    await userEvent.click(screen.getByRole("combobox", { name: "Visit of Store b" }));
    await userEvent.click(await screen.findByRole("option", { name: "Incomplete" }));
    await waitFor(() => expect(api.calls.some((call) => call.url.pathname.endsWith("/b/mark"))).toBe(true));
    expect(api.calls.find((call) => call.url.pathname.endsWith("/b/mark"))!.body).toEqual({ outcome: "incomplete" });
    await userEvent.click(await within(summary).findByRole("button", { name: /Incomplete 1/ }));
    expect(within(within(summary).getByRole("list", { name: "Incomplete stores" })).getByText("Store b")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Visit of Store a" })).toBeNull(); // done by its log entry: not a mark to take back
  });

  it("Move: another installer and day in this plan (or another plan), or remove; no Lock button", async () => {
    const api = renderPlan(makeBundle(), {
      "GET /api/route-plans": () => ({ items: [makeRoutePlan(), makeRoutePlan({ id: "plan2", name: "TX week" })], next_cursor: null }),
      "POST /api/route-plans/plan1/stops/p1/b/move": () => makeBundle(),
    });
    const today = await screen.findByRole("region", { name: "West, day 1" });
    expect(screen.queryByRole("button", { name: /^Lock West/ })).toBeNull();
    expect(within(today).queryByRole("button", { name: "Move Store a" })).toBeNull(); // done
    await userEvent.click(within(today).getByRole("button", { name: "Move Store b" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("combobox", { name: "Plan" }).textContent).toContain("GA week (this plan)");
    expect((within(dialog).getByRole("button", { name: "Move" }) as HTMLButtonElement).disabled).toBe(true); // nothing changed yet
    expect(within(dialog).getByRole("button", { name: /Remove from plan/ })).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Move to installer" }));
    await userEvent.click(await screen.findByRole("option", { name: "East" }));
    await userEvent.clear(within(dialog).getByLabelText("Day"));
    await userEvent.type(within(dialog).getByLabelText("Day"), "2");
    await userEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(api.calls.some((call) => call.url.pathname.endsWith("/b/move"))).toBe(true));
    expect(api.calls.find((call) => call.url.pathname.endsWith("/b/move"))!.body).toEqual({ installer: "East", day: 2, to_plan_id: null, version: 3 });
  });

  it("clicking a day shows only that day on the map, as a chip that clears; the same day again clears too", async () => {
    renderPlan();
    const day2 = await screen.findByRole("region", { name: "West, day 2" });
    await userEvent.click(within(day2).getByRole("button", { name: "Show only West, day 2 on the map" }));
    expect(screen.getByRole("status").textContent).toContain("West · Day 2 · 1 stops");
    await userEvent.click(screen.getByRole("button", { name: "Show every day on the map" }));
    expect(screen.queryByRole("status")).toBeNull();
    await userEvent.click(within(day2).getByRole("button", { name: "Show only West, day 2 on the map" }));
    await userEvent.click(within(day2).getByRole("button", { name: /Show every day on the map \(now only West, day 2\)/ }));
    expect(screen.queryByRole("status")).toBeNull();
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
    await userEvent.click(within(day2).getByRole("button", { name: /Add store/ }));
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
    expect(screen.queryByRole("button", { name: /Log entry/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Move Store/ })).toBeNull();
    expect(screen.queryByRole("combobox", { name: /^Visit of/ })).toBeNull();
    // What is left is the record: the summary, with "Not visited" for what was never done.
    expect(within(screen.getByRole("region", { name: "Plan summary" })).getByRole("button", { name: /Not visited 3/ })).toBeTruthy();
  });

  it("an Operator arranges the plan but does not manage it: a store comes off its day, not out of the plan", async () => {
    const api = renderPlan(makeBundle(), { "POST /api/route-plans/plan1/stops/p1/b/set-aside": () => makeBundle() }, "operator");
    const today = await screen.findByRole("region", { name: "West, day 1" });
    for (const name of [/Plan next day/, /Add stores/, /Edit plan/, /Close plan/, /Add store/]) expect(screen.queryByRole("button", { name }), String(name)).toBeNull();
    expect(within(today).getAllByRole("button", { name: /Log entry/ }).length).toBeGreaterThan(0);
    await userEvent.click(within(today).getByRole("button", { name: "Move Store b" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("combobox", { name: "Plan" })).toBeNull(); // another plan would take it out of this one
    expect(within(dialog).queryByRole("button", { name: /Remove from plan/ })).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: /Remove from this day/ }));
    await waitFor(() => expect(api.calls.some((call) => call.url.pathname.endsWith("/b/set-aside"))).toBe(true));
  });

  it("removed stores stay listed; an Admin puts one back on a day or takes it out, an Operator only sees them", async () => {
    const aside = makePlanStop("z", { installer: "", day: 0, removed: true, removed_by: "Olly", removed_at: "2026-11-06T10:00:00Z" });
    const bundle = makeBundle({ removed: [aside] });
    const api = renderPlan(bundle, { "POST /api/route-plans/plan1/stops/p1/z/restore": () => makeBundle() });
    const removed = await screen.findByRole("region", { name: "Removed stores" });
    expect(removed.textContent).toContain("Store z");
    expect(removed.textContent).toContain("by Olly");
    expect(within(removed).getByRole("button", { name: "Remove Store z from the plan" })).toBeTruthy();
    await userEvent.click(within(removed).getByRole("button", { name: "Put Store z back on a day" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /Put back/ }));
    await waitFor(() => expect(api.calls.some((call) => call.url.pathname.endsWith("/z/restore"))).toBe(true));
    expect(api.calls.find((call) => call.url.pathname.endsWith("/z/restore"))!.body).toMatchObject({ installer: "West", day: 1 });
  });

  it("a Viewer sees the plan and changes nothing", async () => {
    renderPlan(makeBundle({ removed: [makePlanStop("z", { installer: "", day: 0, removed: true })] }), {}, "viewer");
    const today = await screen.findByRole("region", { name: "West, day 1" });
    for (const name of [/Plan next day/, /Close plan/, /Log entry/, /^Move /, /Put .* back/]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(within(today).queryByRole("combobox")).toBeNull(); // no Done / Incomplete picker
    expect(screen.getByRole("region", { name: "Removed stores" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /CSV/ }).length).toBeGreaterThan(0); // reading is fine
  });
});

