import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImportWizard } from "@/features/imports/ImportWizard";
import { jsonError, mockApi, renderWithProviders } from "@/test/render";
import { makeProject } from "@/test/fixtures";
import { DEFAULT_SCHEMA_FOR_TESTS } from "@/test/schema";
import type { ImportResult, ImportRow } from "@/lib/api/types";

function row(index: number, overrides: Partial<ImportRow> = {}): ImportRow {
  return {
    index, address: `${index} Main St`, store_name: `Store ${index}`, pa: "North", status: "valid", confidence: 100,
    verified_by: ["geocoding", "places"], formatted: `${index} Main St, Atlanta, GA 30303, USA`, addr: `${index} Main St`,
    city: "Atlanta", state: "GA", zip: "30303", lat: 33.7 + index / 100, lng: -84.4, place_name: "", suggestions: [],
    error: "", venue_status: "Incomplete", venue_status_valid: true, venue_status_raw: "",
    fields: { dma: "ATL", screens: String(index) }, ...overrides,
  };
}

const RESULT: ImportResult = {
  columns: ["store_name", "address", "pa", "dma", "screens"], address_column: "address", store_column: "store_name",
  extra_columns: ["screens"], summary: { total: 3, valid: 2, needs_review: 1, invalid: 0 }, pa_names: ["North"],
  rows: [
    row(0, { venue_status: "Complete" }),
    row(1, { store_name: "" }),
    row(2, { status: "needs_review", confidence: 0, lat: null, lng: null, formatted: "", suggestions: ["2 Main St NW, Atlanta, GA, USA"] }),
  ],
};

function importRoutes(extra: Record<string, (url: URL, init: RequestInit) => unknown> = {}) {
  return mockApi({
    "GET /api/config/field-schema": () => DEFAULT_SCHEMA_FOR_TESTS,
    "POST /api/jobs/imports": () => ({ job_id: "j1", upload_url: "/api/jobs/j1/upload", upload_key: "uploads/j1/sites.csv" }),
    "PUT /api/jobs/j1/upload": () => undefined,
    "POST /api/jobs/j1/start": () => ({ id: "j1", type: "import_parse", status: "running" }),
    "GET /api/jobs/j1": () => ({
      id: "j1", type: "import_parse", status: "succeeded", project_id: null, progress: 100, message: "done",
      payload: {}, result_key: "jobs/j1/result.json", created_at: "", updated_at: "", result_url: "/api/jobs/j1/result",
    }),
    "GET /api/jobs/j1/result": () => RESULT,
    "GET /api/places/validate": () => ({
      ok: true, status: "OK", formatted: "2 Main St NW, Atlanta, GA 30303, USA", lat: 33.72, lng: -84.39,
      addr: "2 Main St NW", city: "Atlanta", state: "GA", zip: "30303", partial: false, suggestions: [], error: "",
    }),
    ...extra,
  });
}

async function uploadSheet() {
  const file = new File(["store_name,address\nStore 0,0 Main St\n"], "sites.csv", { type: "text/csv" });
  await userEvent.upload(screen.getByLabelText("Spreadsheet file"), file);
  await userEvent.click(screen.getByRole("button", { name: /Upload and verify/ }));
  await screen.findByRole("table", undefined, { timeout: 4000 });
}

async function fixReviewRows() {
  await userEvent.type(screen.getByLabelText("Store name, row 2"), "Named Store");
  await userEvent.click(screen.getByRole("combobox", { name: "Suggestions, row 3" }));
  await userEvent.click(await screen.findByRole("option", { name: "2 Main St NW, Atlanta, GA, USA" }));
  await waitFor(() => expect(screen.getByText("3 ready · 0 excluded")).toBeTruthy());
}

describe("ImportWizard: new project", () => {
  it("runs details → upload → review → mapping and creates the project", async () => {
    const { calls } = importRoutes({
      "POST /api/projects": () => ({ project: makeProject({ id: "new1", name: "Wave 3" }), job_id: "r1" }),
    });
    renderWithProviders(<ImportWizard open onClose={() => {}} />);

    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByText("Project name is required")).toBeTruthy();
    expect(screen.getByText("Add at least one installer")).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Project name *"), "Wave 3");
    await userEvent.type(screen.getByLabelText("PA *"), "North");
    await userEvent.type(screen.getByLabelText("PA % *"), "40");
    await userEvent.type(screen.getByLabelText("Dolphin % *"), "60");
    await userEvent.type(screen.getByLabelText("Installers *"), "Ann{Enter}");
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));

    await uploadSheet();
    const upload = calls.find((call) => call.method === "PUT");
    expect(upload?.url.pathname).toBe("/api/jobs/j1/upload");
    expect(calls.find((call) => call.url.pathname === "/api/jobs/imports")?.body).toMatchObject({
      filename: "sites.csv", content_type: "text/csv", project_id: null,
    });

    expect(screen.getByText("1 ready · 0 excluded")).toBeTruthy();
    expect(within(screen.getByRole("table")).getAllByText("Store name is required").length).toBe(1);
    await fixReviewRows();
    await userEvent.click(screen.getByRole("button", { name: /Next: map columns/ }));

    expect(screen.getByRole("combobox", { name: "Field for column dma" }).textContent).toContain("DMA");
    await userEvent.click(screen.getByRole("combobox", { name: "Field for column screens" }));
    await userEvent.click(await screen.findByRole("option", { name: "Add as a new field" }));
    await userEvent.click(screen.getByRole("button", { name: "Create project with 3 stores" }));

    await waitFor(() => expect(screen.getByTestId("navigated")).toBeTruthy());
    const body = calls.find((call) => call.method === "POST" && call.url.pathname === "/api/projects")?.body as {
      name: string; installers: string[]; stops_per_day: number; field_schema: { key: string }[];
      stops: { store_name: string; addr: string; lat: number; fields: Record<string, string>; initial_status: string }[];
    };
    expect(body).toMatchObject({ name: "Wave 3", installers: ["Ann"], stops_per_day: 8, pa_percentage: 40 });
    expect(body.field_schema.at(-1)).toMatchObject({ key: "screens", source_column: "screens" });
    expect(body.stops.map((stop) => stop.store_name)).toEqual(["Store 0", "Named Store", "Store 2"]); // typing kept the row mounted
    expect(body.stops[0]).toMatchObject({ initial_status: "Complete", fields: { pa: "North", dma: "ATL", screens: "0" } });
    expect(body.stops[2]).toMatchObject({ addr: "2 Main St NW", lat: 33.72 });
  });
});

describe("ImportWizard: append", () => {
  it("retries a failed append without re-sending the schema PATCH with a stale version", async () => {
    const project = makeProject({ id: "p1", version: 4 });
    let appendFails = true;
    const { calls } = importRoutes({
      "PATCH /api/projects/p1": (_url, init) => {
        const body = JSON.parse(String(init.body)) as { expected_version: number; field_schema: unknown[] };
        if (body.expected_version !== 4) return jsonError(409, "Project was modified concurrently");
        return { ...project, version: 5, field_schema: body.field_schema };
      },
      "POST /api/projects/p1/stores/append": () =>
        appendFails ? jsonError(409, "Routing is in progress") : { appended: 3, total: 6, skipped: [] },
    });
    renderWithProviders(<ImportWizard open appendTo={project} onClose={() => {}} />);
    await uploadSheet();
    await fixReviewRows();
    await userEvent.click(screen.getByRole("button", { name: /Next: map columns/ }));
    await userEvent.click(screen.getByRole("combobox", { name: "Field for column screens" }));
    await userEvent.click(await screen.findByRole("option", { name: "Add as a new field" }));
    await userEvent.click(screen.getByRole("button", { name: "Append 3 stores" }));
    await waitFor(() => expect(calls.filter((call) => call.url.pathname.endsWith("/stores/append"))).toHaveLength(1));

    appendFails = false;
    await userEvent.click(screen.getByRole("button", { name: "Append 3 stores" }));
    expect(await screen.findByText(/Appended 3 stores; the project now has 6/)).toBeTruthy();
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1); // the schema was saved once
  });

  it("adds new fields to the project schema, appends and lists skipped duplicates", async () => {
    const project = makeProject({ id: "p1", version: 4 });
    const { calls } = importRoutes({
      "PATCH /api/projects/p1": () => ({ ...project, version: 5 }),
      "POST /api/projects/p1/stores/append": () => ({
        appended: 2, total: 5, skipped: [{ addr: "0 Main St", venue_code: "", reason: "duplicate" }],
      }),
    });
    renderWithProviders(<ImportWizard open appendTo={project} onClose={() => {}} />);
    expect(screen.queryByLabelText("Project name *")).toBeNull(); // no details step
    await uploadSheet();
    expect(calls.find((call) => call.url.pathname === "/api/jobs/imports")?.body).toMatchObject({ project_id: "p1" });
    await fixReviewRows();
    await userEvent.click(screen.getByRole("button", { name: /Next: map columns/ }));
    await userEvent.click(screen.getByRole("combobox", { name: "Field for column screens" }));
    await userEvent.click(await screen.findByRole("option", { name: "Add as a new field" }));
    await userEvent.click(screen.getByRole("button", { name: "Append 3 stores" }));

    expect(await screen.findByText(/Appended 2 stores; the project now has 5/)).toBeTruthy();
    expect(screen.getByText(/1 skipped as duplicates/)).toBeTruthy();
    const patch = calls.find((call) => call.method === "PATCH")?.body as { field_schema: { key: string }[]; expected_version: number };
    expect(patch.expected_version).toBe(4);
    expect(patch.field_schema.at(-1)?.key).toBe("screens");
    const appended = calls.find((call) => call.url.pathname.endsWith("/stores/append"))?.body as { stops: unknown[]; pa: string };
    expect(appended.stops).toHaveLength(3);
    expect(appended.pa).toBe("North");
    const order = calls.map((call) => `${call.method} ${call.url.pathname}`);
    expect(order.indexOf("PATCH /api/projects/p1")).toBeLessThan(order.indexOf("POST /api/projects/p1/stores/append"));
  });
});

describe("ImportWizard: fetch errors", () => {
  async function startAppend(extra: Parameters<typeof importRoutes>[0]) {
    const api = importRoutes(extra);
    renderWithProviders(<ImportWizard open appendTo={makeProject({ id: "p1" })} onClose={() => {}} />);
    const file = new File(["store_name,address\n"], "sites.csv", { type: "text/csv" });
    await userEvent.upload(screen.getByLabelText("Spreadsheet file"), file);
    await userEvent.click(screen.getByRole("button", { name: /Upload and verify/ }));
    return api;
  }

  it("shows a result fetch error with a retry that recovers", async () => {
    let fail = true;
    await startAppend({ "GET /api/jobs/j1/result": () => (fail ? jsonError(500, "S3 is down") : RESULT) });
    const alert = await screen.findByRole("alert", undefined, { timeout: 4000 });
    expect(alert.textContent).toContain("Could not load the verified rows: S3 is down");
    fail = false;
    await userEvent.click(within(alert).getByRole("button", { name: /Retry/ }));
    expect(await screen.findByRole("table")).toBeTruthy();
  });

  it("shows a default-schema fetch error for a new project with a retry", async () => {
    let fail = true;
    importRoutes({ "GET /api/config/field-schema": () => (fail ? jsonError(503, "unavailable") : DEFAULT_SCHEMA_FOR_TESTS) });
    renderWithProviders(<ImportWizard open onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText("Project name *"), "Wave 3");
    await userEvent.type(screen.getByLabelText("PA *"), "North");
    await userEvent.type(screen.getByLabelText("PA % *"), "40");
    await userEvent.type(screen.getByLabelText("Dolphin % *"), "60");
    await userEvent.type(screen.getByLabelText("Installers *"), "Ann{Enter}");
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load the default store fields: unavailable");
    fail = false;
    await userEvent.click(within(alert).getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
