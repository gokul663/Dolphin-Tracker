import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { ProjectPage } from "@/features/projects/ProjectPage";
import { SettingsTab } from "@/features/settings/SettingsTab";
import { jsonError, mockApi, renderWithProviders } from "@/test/render";
import { makeProject } from "@/test/fixtures";
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
  it("shows the building banner while routing runs", async () => {
    mockApi({ "GET /api/projects/p1": () => makeProject({ routing_status: "building" }) });
    renderProject("stores");
    expect(await screen.findByText(/Routing in progress/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Atlanta refresh" })).toBeTruthy();
    expect(screen.getByText("stores tab")).toBeTruthy();
  });

  it("offers a rebuild after a failed build", async () => {
    const { calls } = mockApi({
      "GET /api/projects/p1": () => makeProject({ routing_status: "failed" }),
      "POST /api/projects/p1/routing/recluster": () => ({ job_id: "j1" }),
    });
    renderProject("stores");
    await userEvent.click(await screen.findByRole("button", { name: /Rebuild routes/ }));
    await waitFor(() => expect(calls.some((call) => call.url.pathname.endsWith("/routing/recluster"))).toBe(true));
  });

  it("explains a missing project", async () => {
    mockApi({ "GET /api/projects/p1": () => jsonError(404, "Project p1 not found") });
    renderProject();
    expect(await screen.findByText("This project does not exist.")).toBeTruthy();
  });
});

describe("Settings tab", () => {
  it("validates and saves the stops-per-day cap with the version", async () => {
    const { calls } = mockApi({
      "GET /api/projects/p1": () => makeProject(),
      "PATCH /api/projects/p1": () => makeProject({ stops_per_day: 30, version: 2 }),
    });
    renderProject();
    const cap = await screen.findByLabelText(/Stops per day/);
    await userEvent.clear(cap);
    await userEvent.type(cap, "60");
    await userEvent.click(screen.getByRole("button", { name: "Save details" }));
    expect(await screen.findByText("At most 50")).toBeTruthy();
    await userEvent.clear(cap);
    await userEvent.type(cap, "30");
    await userEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(body(calls, "PATCH", "/api/projects/p1")).toMatchObject({ stops_per_day: 30, expected_version: 1 }));
  });

  it("adds an installer as a job and renames one", async () => {
    const { calls } = mockApi({
      "GET /api/projects/p1": () => makeProject(),
      "POST /api/projects/p1/installers": () => ({ job_id: "j1" }),
      "POST /api/projects/p1/installers/rename": () => makeProject({ installers: ["Anna", "Bo"] }),
    });
    renderProject();
    const input = await screen.findByLabelText("New installer name");
    await userEvent.type(input, "Bo");
    expect(screen.getByText("An installer with that name already exists.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Add installer/ }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(input);
    await userEvent.type(input, " Cy ");
    await userEvent.click(screen.getByRole("button", { name: /Add installer/ }));
    await waitFor(() => expect(body(calls, "POST", "/api/projects/p1/installers")).toEqual({ name: "Cy" }));

    await userEvent.click(screen.getByRole("button", { name: "Rename Ann" }));
    const rename = screen.getByLabelText("New name for Ann");
    await userEvent.clear(rename);
    await userEvent.type(rename, "Anna{Enter}");
    await waitFor(() =>
      expect(body(calls, "POST", "/api/projects/p1/installers/rename")).toEqual({ old_name: "Ann", new_name: "Anna" }),
    );
  });

  it("pauses installer changes while routing runs", async () => {
    mockApi({ "GET /api/projects/p1": () => makeProject({ routing_status: "building" }) });
    renderProject();
    expect(await screen.findByText("Installer changes are paused while routing runs.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Rename Ann" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("edits the field schema with the backend's rules", async () => {
    const { calls } = mockApi({
      "GET /api/projects/p1": () => makeProject(),
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
      "GET /api/projects/p1": () => makeProject(),
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
