import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TechnicianHome } from "@/features/technician/TechnicianHome";
import { makeBundle, makePlanStop, makeRoutePlan, WEST } from "@/test/planFixtures";
import { mockApi, renderWithProviders } from "@/test/render";

const WEST_ENTRY = { id: "i1", value: "West", created_at: "", phone: "555 010 1000", phone2: "", email: "west@example.com", email2: "", shipping_address: "" };

/** West's own cut of a plan on its second day: one finished day, today (one done, one incomplete), one day ahead. */
function ownBundle() {
  return makeBundle({
    plan: makeRoutePlan({
      installers: [{ name: "West", start: WEST, stops_per_day: null, max_day_hours: null, start_date: null }],
      days: [
        { number: 1, date: "2026-11-06", starts: { West: WEST }, stops_per_day: null, max_day_hours: null },
        { number: 2, date: "2026-11-09", starts: { West: WEST }, stops_per_day: null, max_day_hours: null },
      ],
    }),
    stops: [
      makePlanStop("a", { day: 1, visited_screens: ["a-s1"] }),
      makePlanStop("b", { day: 2, seq: 0, outcome: "done" }),
      makePlanStop("c", { day: 2, seq: 1, outcome: "incomplete", drive_minutes: 25 }),
      makePlanStop("d", { day: 3, seq: 0 }),
    ],
  });
}

function renderHome(route: unknown, extra: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({ "GET /api/my/route": () => route, ...extra });
  renderWithProviders(<TechnicianHome />, { role: "technician" });
  return api;
}

afterEach(() => vi.restoreAllMocks());

describe("TechnicianHome", () => {
  it("shows today's route, the days to come and how much is serviced", async () => {
    renderHome({ installer: WEST_ENTRY, plans: [ownBundle()], serviced_before: 5, fixed: { new_installation: 12, offline: 4, mixed: 0 } });
    const numbers = await screen.findByLabelText("Your numbers");
    expect(numbers.textContent).toContain("Serviced7"); // two on this route, five before
    expect(numbers.textContent).toContain("2 on current routes · 5 before");
    expect(numbers.textContent).toContain("Today2");
    expect(numbers.textContent).toContain("1 still to do");
    expect(numbers.textContent).toContain("Upcoming1");
    expect(numbers.textContent).toContain("Incomplete1");

    const fixed = screen.getByRole("region", { name: "Stores fixed so far" });
    expect(fixed.textContent).toContain("16Total");
    expect(fixed.textContent).toContain("12New installations");
    expect(fixed.textContent).toContain("4Offline fixed");
    expect(fixed.textContent).not.toContain("mixed projects"); // only when there are any

    const today = within(screen.getByRole("region", { name: "Today" })).getByRole("group", { name: "Day 2 of GA week" });
    expect((today as HTMLDetailsElement).open).toBe(true);
    const lines = within(today).getAllByRole("listitem");
    expect(lines.map((line) => line.textContent)).toEqual([expect.stringContaining("Store b"), expect.stringContaining("Store c")]);
    expect(lines[0]!.textContent).toContain("Done");
    expect(lines[1]!.textContent).toContain("Incomplete");
    expect(lines[1]!.textContent).toContain("25m drive");
    // The route link is for what is still to do, from the day's start.
    const link = within(today).getByRole("link", { name: /Open route in Google Maps/ }).getAttribute("href") ?? "";
    expect(link).toContain(encodeURIComponent("West depot, GA"));
    expect(link).toContain(encodeURIComponent("c Main St"));
    expect(link).not.toContain(encodeURIComponent("b Main St"));

    const ahead = within(screen.getByRole("region", { name: "Upcoming days" })).getByRole("group", { name: "Day 3 of GA week" });
    expect((ahead as HTMLDetailsElement).open).toBe(false); // closed until opened
    expect(screen.getByRole("region", { name: "Earlier days" }).textContent).toContain("Day 1");
    expect(screen.queryByRole("button", { name: /Log|Move/ })).toBeNull(); // a view, apart from their own details
  });

  it("saves only their additional phone and shipping address", async () => {
    const api = renderHome({ installer: WEST_ENTRY, plans: [], serviced_before: 0, fixed: { new_installation: 0, offline: 0, mixed: 0 } }, { "PUT /api/my/profile": () => WEST_ENTRY });
    const details = await screen.findByRole("region", { name: "Your details" });
    expect(details.textContent).toContain("555 010 1000");
    expect(within(details).queryByLabelText("Name")).toBeNull(); // shown, not a box
    const save = within(details).getByRole("button", { name: /Save my details/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await userEvent.type(within(details).getByLabelText("Additional phone"), "555 010 1999");
    await userEvent.type(within(details).getByLabelText("Shipping address"), "1 West St");
    await userEvent.click(save);
    await waitFor(() => expect(api.calls.some((call) => call.method === "PUT")).toBe(true));
    expect(api.calls.find((call) => call.method === "PUT")!.body).toEqual({ phone2: "555 010 1999", shipping_address: "1 West St" });
    expect(screen.getByText("You are not on a route right now.")).toBeTruthy();
  });

  it("says so when the sign-in is not linked to an installer", async () => {
    renderHome({ installer: null, plans: [], serviced_before: 0, fixed: { new_installation: 0, offline: 0, mixed: 0 } });
    expect(await screen.findByRole("heading", { name: /not linked to an installer/ })).toBeTruthy();
  });
});
