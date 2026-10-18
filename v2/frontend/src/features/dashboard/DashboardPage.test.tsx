import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DashboardPage } from "@/features/dashboard/DashboardPage";
import { jsonError, mockApi, renderWithProviders } from "@/test/render";
import { makeSummary } from "@/test/fixtures";

const done = makeSummary({
  id: "p2", name: "Macon wave", installers: ["Cy"],
  kpi: { ...makeSummary().kpi, total: 3, complete: 3, pending: 0, offline: 0, by_installer: { Cy: 3 } },
});

function kpi(label: string) {
  return within(screen.getByRole("group", { name: label })).getByText(/^\d+$/).textContent;
}

describe("DashboardPage", () => {
  it("pages through projects, aggregates KPIs and filters by tab", async () => {
    let page = 0;
    mockApi({
      "GET /api/projects": () => (page++ === 0 ? { items: [makeSummary()], next_cursor: "c1" } : { items: [done], next_cursor: null }),
    });
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText("Atlanta refresh")).toBeTruthy();
    expect(screen.getByText("Macon wave")).toBeTruthy();
    expect(kpi("Total projects")).toBe("2");
    expect(kpi("Total sites")).toBe("13");
    expect(kpi("Total installers")).toBe("3");
    expect(kpi("Completed")).toBe("7");

    await userEvent.click(screen.getByRole("tab", { name: /Completed \(1\)/ }));
    expect(screen.queryByText("Atlanta refresh")).toBeNull();
    expect(screen.getByText("Macon wave")).toBeTruthy();
  });

  it("loads the chart row lazily after the page renders", async () => {
    mockApi({ "GET /api/projects": () => ({ items: [makeSummary()], next_cursor: null }) });
    renderWithProviders(<DashboardPage />);
    await screen.findByText("Atlanta refresh");
    expect(await screen.findByText("Sites by installer")).toBeTruthy();
    expect(screen.getByText("Status breakdown")).toBeTruthy();
    expect(screen.getByText("Sites per project")).toBeTruthy();
  });

  it("narrows KPIs with the project filter", async () => {
    mockApi({ "GET /api/projects": () => ({ items: [makeSummary(), done], next_cursor: null }) });
    renderWithProviders(<DashboardPage />);
    await screen.findByText("Atlanta refresh");
    await userEvent.click(screen.getByRole("button", { name: /All projects/ }));
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: /Macon wave/ }));
    await waitFor(() => expect(kpi("Total projects")).toBe("1"));
    expect(kpi("Total sites")).toBe("10");
  });

  it("shows an error with retry", async () => {
    mockApi({ "GET /api/projects": () => jsonError(500, "boom") });
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText(/Could not load projects: boom/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("deletes only after the exact name is typed", async () => {
    const { calls } = mockApi({
      "GET /api/projects": () => ({ items: [makeSummary()], next_cursor: null }),
      "DELETE /api/projects/p1": () => undefined,
    });
    renderWithProviders(<DashboardPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete Atlanta refresh" }));
    const dialog = await screen.findByRole("dialog");
    const remove = within(dialog).getByRole("button", { name: "Delete" });
    expect((remove as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(within(dialog).getByLabelText(/to confirm/), "Atlanta refresh "); // trailing space: trimmed
    expect((remove as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(remove);
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true));
    const call = calls.find((entry) => entry.method === "DELETE");
    expect(call?.url.searchParams.get("confirm")).toBe("Atlanta refresh");
  });

  it("edits metadata with client-side validation and an optimistic version", async () => {
    const { calls } = mockApi({
      "GET /api/projects": () => ({ items: [makeSummary()], next_cursor: null }),
      "PATCH /api/projects/p1": () => makeSummary({ name: "Renamed" }),
    });
    renderWithProviders(<DashboardPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit details for Atlanta refresh" }));
    const dialog = await screen.findByRole("dialog");
    const pct = within(dialog).getByLabelText("PA % *");
    await userEvent.clear(pct);
    await userEvent.type(pct, "140");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("PA % must be between 0 and 100")).toBeTruthy();
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);

    await userEvent.clear(pct);
    await userEvent.type(pct, "45");
    await userEvent.clear(within(dialog).getByLabelText("Project name *"));
    await userEvent.type(within(dialog).getByLabelText("Project name *"), "Renamed");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    const body = calls.find((call) => call.method === "PATCH")?.body as Record<string, unknown>;
    expect(body).toMatchObject({ name: "Renamed", pa_percentage: 45, store_percentage: null, expected_version: 1 });
  });
});
