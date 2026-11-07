import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { ProjectPage } from "@/features/projects/ProjectPage";
import { SettingsTab } from "@/features/settings/SettingsTab";
import { jsonError, mockApi, renderWithProviders } from "@/test/render";
import { makeProject, makeSummary } from "@/test/fixtures";
import type { Project } from "@/lib/api/types";

function renderProject(tab = "settings") {
  return renderWithProviders(
    <Routes>
      <Route path="projects/:projectId" element={<ProjectPage />}>
        <Route path="settings" element={<SettingsTab />} />
        <Route path="stores" element={<div>stores tab</div>} />
      </Route>
    </Routes>,
    { path: "/*", route: `/projects/p1/${tab}` },
  );
}

function body(calls: { method: string; url: URL; body: unknown }[], method: string, path: string) {
  return calls.find((call) => call.method === method && call.url.pathname === path)?.body as Record<string, unknown>;
}

describe("Project shell", () => {
  it("shows no installers, per-day cap or routing banner: those belong to route plans", async () => {
    mockApi({ "GET /api/projects/p1": () => makeSummary({ routing_status: "failed" }) });
    renderProject("stores");
    expect(await screen.findByRole("heading", { name: "Atlanta refresh" })).toBeTruthy();
    expect(screen.getByText("stores tab")).toBeTruthy();
    expect(screen.queryByText(/stops\/day/)).toBeNull();
    expect(screen.queryByText(/\d+ installers/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Rebuild routes/ })).toBeNull();
  });

  it("explains a missing project", async () => {
    mockApi({ "GET /api/projects/p1": () => jsonError(404, "Project p1 not found") });
    renderProject();
    expect(await screen.findByText("This project does not exist.")).toBeTruthy();
  });
});

describe("Settings tab", () => {
  it("saves project details with the version, without installers or a per-day cap", async () => {
    const { calls } = mockApi({
      "GET /api/projects/p1": () => makeSummary(),
      "PATCH /api/projects/p1": () => makeProject({ name: "Renamed", version: 2 }),
    });
    renderProject();
    const name = await screen.findByLabelText("Project name *");
    expect(screen.queryByLabelText(/Stops per day/)).toBeNull();
    expect(screen.queryByLabelText("New installer name")).toBeNull();
    await userEvent.clear(name);
    await userEvent.type(name, "Renamed");
    await userEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(body(calls, "PATCH", "/api/projects/p1")).toMatchObject({ name: "Renamed", expected_version: 1 }));
    expect(body(calls, "PATCH", "/api/projects/p1")).not.toHaveProperty("stops_per_day");
  });

  it("edits the field schema with the backend's rules", async () => {
    const { calls } = mockApi({
      "GET /api/projects/p1": () => makeSummary(),
      "PATCH /api/projects/p1": (_url, init) => {
        const sent = JSON.parse(String(init.body)) as { field_schema: Project["field_schema"] };
        return makeProject({ field_schema: sent.field_schema, version: 2 });
      },
      "GET /api/projects/p1/stores/field-usage": () => ({ owner_phone: 4 }), // nobody has a payee name
    });
    renderProject();
    await userEvent.click(await screen.findByRole("button", { name: "Add field" }));
    const label = screen.getByLabelText("Label for field 9");
    await userEvent.clear(label);
    await userEvent.type(label, "Screen Tier");
    expect(screen.getByText("screen_tier")).toBeTruthy(); // key derived from the label
    await userEvent.click(screen.getByRole("combobox", { name: "Type for Screen Tier" }));
    await userEvent.click(await screen.findByRole("option", { name: "Select" }));
    expect(await screen.findByText("Select fields need at least one option")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save fields" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Options for Screen Tier"), "Gold, Silver, Gold");
    await userEvent.click(screen.getByRole("checkbox", { name: "Screen Tier is required" }));

    await userEvent.click(screen.getByRole("button", { name: "Remove Payee Name" }));
    expect(screen.getByText(/Removing Payee Name hides those values/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Move Screen Tier up" }));

    await userEvent.click(screen.getByRole("button", { name: "Save fields" }));
    await waitFor(() => expect(body(calls, "PATCH", "/api/projects/p1")).toBeTruthy());
    const sent = body(calls, "PATCH", "/api/projects/p1") as { field_schema: { key: string; options: string[]; required: boolean }[] };
    const keys = sent.field_schema.map((field) => field.key);
    expect(keys).not.toContain("payee_name");
    expect(keys.slice(-2)).toEqual(["screen_tier", "owner_email"]);
    expect(sent.field_schema.find((field) => field.key === "screen_tier")).toMatchObject({ options: ["Gold", "Silver"], required: true });
    const table = screen.getByRole("table");
    expect(within(table).getByText("owner_phone")).toBeTruthy(); // saved keys shown, not editable inputs
  });

  it("asks before removing a field that stores have values for, with the count", async () => {
    const { calls } = mockApi({
      "GET /api/projects/p1": () => makeSummary(),
      "GET /api/projects/p1/stores/field-usage": () => ({ payee_name: 3 }),
      "PATCH /api/projects/p1": () => makeProject({ version: 2 }),
    });
    renderProject();
    await userEvent.click(await screen.findByRole("button", { name: "Remove Payee Name" }));
    await userEvent.click(screen.getByRole("button", { name: "Save fields" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Payee Name: 3 stores have a value")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Save fields" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove and save" }));
    await waitFor(() => expect(body(calls, "PATCH", "/api/projects/p1")).toBeTruthy());
  });
});
