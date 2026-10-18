import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImportWizard } from "@/features/imports/ImportWizard";
import { jsonError, mockApi, renderWithProviders } from "@/test/render";
import { makeImportRow as row, makeProject } from "@/test/fixtures";
import { STORE_FIELDS_FOR_TESTS } from "@/test/storeFields";
import type { ImportResult, StopInput } from "@/lib/api/types";

const RESULT: ImportResult = {
  columns: ["ibc", "store_name", "store_address", "dma", "notes"],
  mapping: { ibc: "external_id", store_name: "store_name", store_address: "addr", dma: "dma", notes: "" },
  address_column: "store_address", store_column: "store_name", extra_columns: ["notes"],
  summary: { total: 4, valid: 3, needs_review: 1, invalid: 0, duplicates: 1 }, pa_names: ["North"],
  rows: [
    row(0, { venue_status: "Completed", details: { dma: "ATL" }, fields: { notes: "side door" },
             screens: [{ stick_number: "S1", venue_id: "V1", status: "Completed" }] }),
    row(1, { external_id: "", problems: { external_id: "IBC# is required" } }),
    row(2, { status: "needs_review", confidence: 0, lat: null, lng: null, formatted: "", coordinates_source: "",
             suggestions: ["2 Main St NW, Atlanta, GA, USA"] }),
    row(3, { duplicate_of: 0, duplicate_reason: "external_id", external_id: "IBC-0", store_name: "Store 0 again" }),
  ],
};

/** The server's answer to re-pointing `notes` to Installation comments: the rows' values move accordingly. */
const REMAPPED: ImportResult = {
  ...RESULT,
  mapping: { ...RESULT.mapping, notes: "installation_notes" },
  extra_columns: [],
  rows: RESULT.rows.map((r) => (r.index === 0 ? { ...r, fields: {}, details: { ...r.details, installation_notes: "side door" } } : r)),
};

function importRoutes(extra: Record<string, (url: URL, init: RequestInit) => unknown> = {}) {
  return mockApi({
    "GET /api/config/store-fields": () => STORE_FIELDS_FOR_TESTS,
    "POST /api/jobs/imports": () => ({ job_id: "j1", upload_url: "/api/jobs/j1/upload", upload_key: "uploads/j1/sites.csv" }),
    "PUT /api/jobs/j1/upload": () => undefined,
    "POST /api/jobs/j1/start": () => ({ id: "j1", type: "import_parse", status: "running" }),
    "GET /api/jobs/j1": () => ({
      id: "j1", type: "import_parse", status: "succeeded", project_id: null, progress: 100, message: "done",
      payload: {}, result_key: "jobs/j1/result.json", created_at: "", updated_at: "", result_url: "/api/jobs/j1/result",
    }),
    "GET /api/jobs/j1/result": () => RESULT,
    "POST /api/jobs/j1/mapping": () => REMAPPED,
    "GET /api/places/validate": () => ({
      ok: true, status: "OK", formatted: "2 Main St NW, Atlanta, GA 30303, USA", lat: 33.72, lng: -84.39,
      addr: "2 Main St NW", city: "Atlanta", state: "GA", zip: "30303", partial: false, suggestions: [], error: "",
    }),
    ...extra,
  });
}

async function uploadSheet() {
  const file = new File(["IBC#,Store Name,Store Address\n"], "ibc.csv", { type: "text/csv" });
  await userEvent.upload(screen.getByLabelText("Spreadsheet file"), file);
  await userEvent.click(screen.getByRole("button", { name: /Upload and verify/ }));
  await screen.findByRole("combobox", { name: "Field for column dma" }, { timeout: 4000 }); // the Columns step
}

async function fixReviewRows() {
  await userEvent.type(screen.getByLabelText("IBC#, row 2"), "ibc-new");
  await userEvent.click(screen.getByRole("combobox", { name: "Suggestions, row 3" }));
  await userEvent.click(await screen.findByRole("option", { name: "2 Main St NW, Atlanta, GA, USA" }));
  await waitFor(() => expect(screen.getByText("3 ready · 1 excluded")).toBeTruthy());
}

async function fillDetails() {
  await userEvent.type(screen.getByLabelText("Project name *"), "Wave 3");
  await userEvent.type(screen.getByLabelText("PA *"), "North");
  await userEvent.type(screen.getByLabelText("PA % *"), "40");
  await userEvent.type(screen.getByLabelText("Dolphin % *"), "60");
  await userEvent.type(screen.getByLabelText("Installers *"), "Ann{Enter}");
}

describe("ImportWizard: new project", () => {
  it("details → upload → columns (re-point) → review (duplicates, fixes) → create with the mapping", async () => {
    const { calls } = importRoutes({
      "POST /api/projects": () => ({ project: makeProject({ id: "new1", name: "Wave 3" }), job_id: "r1", skipped: [] }),
    });
    renderWithProviders(<ImportWizard open onClose={() => {}} />);

    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByText("Project name is required")).toBeTruthy();
    expect(screen.getByText("Add at least one installer")).toBeTruthy();
    await fillDetails();
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await uploadSheet();

    // Columns: the detected mapping, address columns locked, a re-point goes to the server with every column.
    expect(screen.getByRole("combobox", { name: "Field for column dma" }).textContent).toContain("DMA");
    expect(screen.queryByRole("combobox", { name: "Field for column store_address" })).toBeNull(); // locked
    expect(screen.getByText("Address")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Field for column notes" }).textContent).toContain("Other imported data");
    await userEvent.click(screen.getByRole("combobox", { name: "Field for column notes" }));
    expect((await screen.findByRole("option", { name: /^DMA/ })).getAttribute("aria-disabled")).toBe("true"); // taken
    await userEvent.click(screen.getByRole("option", { name: "Installation comments" }));
    await waitFor(() => expect(calls.find((call) => call.url.pathname === "/api/jobs/j1/mapping")?.body).toEqual({
      mapping: { ...RESULT.mapping, notes: "installation_notes" },
    }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Field for column notes" }).textContent).toContain("Installation comments"));

    // Review: the duplicate is excluded with its reason; fix the rest.
    await userEvent.click(screen.getByRole("button", { name: /Next: review 4 rows/ }));
    await userEvent.click(screen.getByRole("button", { name: /1 duplicates/ }));
    expect(screen.getByRole("note").textContent).toBe("Duplicate: Same IBC# as row 1");
    expect(screen.getByRole("checkbox", { name: "Exclude row 4" }).hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: /4 all rows/ }));
    expect(screen.getByLabelText("Screens, row 1").textContent).toBe("1 screen · S1/V1");
    await fixReviewRows();
    await userEvent.click(screen.getByRole("button", { name: "Create project with 3 stores" }));

    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.url.pathname === "/api/projects")).toBe(true));
    const body = calls.find((call) => call.method === "POST" && call.url.pathname === "/api/projects")?.body as {
      stops: StopInput[]; import_mapping: Record<string, string>; pa: string;
    };
    expect(body.import_mapping).toEqual(REMAPPED.mapping); // saved on the project for its next sheet
    expect(body.pa).toBe("North");
    expect(body.stops.map((stop) => stop.external_id)).toEqual(["IBC-0", "IBC-NEW", "IBC-2"]); // no duplicate
    expect(body.stops[0]).toMatchObject({
      dma: "ATL", installation_notes: "side door", fields: {}, screens: [{ stick_number: "S1", venue_id: "V1", status: "Completed" }],
    });
    expect(body.stops[2]).toMatchObject({ addr: "2 Main St NW", lat: 33.72 });
  });

  it("shows a re-map refusal from the server", async () => {
    importRoutes({
      "POST /api/jobs/j1/mapping": () =>
        jsonError(422, { message: "The mapping cannot be applied", errors: ["Columns 'notes' and 'x' both map to 'dma'"] }),
    });
    renderWithProviders(<ImportWizard open appendTo={makeProject({ id: "p1" })} onClose={() => {}} />);
    await uploadSheet();
    await userEvent.click(screen.getByRole("combobox", { name: "Field for column notes" }));
    await userEvent.click(await screen.findByRole("option", { name: "Installation comments" }));
    expect((await screen.findByRole("alert")).textContent).toContain("both map to 'dma'");
  });
});

describe("ImportWizard: append", () => {
  async function toReview() {
    await uploadSheet();
    await userEvent.click(screen.getByRole("button", { name: /Next: review/ }));
    await fixReviewRows();
  }

  it("appends with the mapping and lists the stores skipped as duplicates", async () => {
    const project = makeProject({ id: "p1", version: 4 });
    const { calls } = importRoutes({
      "POST /api/projects/p1/stores/append": () => ({
        appended: 2, total: 5, skipped: [{ index: 0, external_id: "IBC-0", store_name: "Store 0", addr: "0 Main St", reason: "external_id" }],
      }),
    });
    renderWithProviders(<ImportWizard open appendTo={project} onClose={() => {}} />);
    expect(screen.queryByLabelText("Project name *")).toBeNull(); // no details step
    await toReview();
    expect(calls.find((call) => call.url.pathname === "/api/jobs/imports")?.body).toMatchObject({ project_id: "p1" });
    await userEvent.click(screen.getByRole("button", { name: "Append 3 stores" }));

    expect(await screen.findByText(/Appended 2 stores; the project now has 5/)).toBeTruthy();
    expect(screen.getByText(/1 skipped as duplicates/)).toBeTruthy();
    expect(screen.getByText("Store 0 · IBC# IBC-0")).toBeTruthy();
    const appended = calls.find((call) => call.url.pathname.endsWith("/stores/append"))?.body as {
      stops: StopInput[]; pa: string; import_mapping: Record<string, string>;
    };
    expect(appended.stops).toHaveLength(3);
    expect(appended.pa).toBe("North");
    expect(appended.import_mapping).toEqual(RESULT.mapping);
    expect(calls.some((call) => call.method === "PATCH")).toBe(false); // the project schema is not touched any more
  });

  it("retries a failed append", async () => {
    let fails = true;
    const { calls } = importRoutes({
      "POST /api/projects/p1/stores/append": () => (fails ? jsonError(409, "Routing is in progress") : { appended: 3, total: 6, skipped: [] }),
    });
    renderWithProviders(<ImportWizard open appendTo={makeProject({ id: "p1" })} onClose={() => {}} />);
    await toReview();
    await userEvent.click(screen.getByRole("button", { name: "Append 3 stores" }));
    await waitFor(() => expect(calls.filter((call) => call.url.pathname.endsWith("/stores/append"))).toHaveLength(1));
    fails = false;
    await userEvent.click(screen.getByRole("button", { name: "Append 3 stores" }));
    expect(await screen.findByText(/Appended 3 stores; the project now has 6/)).toBeTruthy();
  });

  it("asks before importing rows with unusable values, or drops those values", async () => {
    const withProblem: ImportResult = {
      ...RESULT,
      rows: [row(0, { details: { owner_email: "nope" }, problems: { owner_email: "Store owner email: enter a valid email" } })],
    };
    const { calls } = importRoutes({
      "GET /api/jobs/j1/result": () => withProblem,
      "POST /api/projects/p1/stores/append": () => ({ appended: 1, total: 1, skipped: [] }),
    });
    renderWithProviders(<ImportWizard open appendTo={makeProject({ id: "p1" })} onClose={() => {}} />);
    await uploadSheet();
    await userEvent.click(screen.getByRole("button", { name: /Next: review/ }));
    expect(screen.getByText("Store owner email: enter a valid email")).toBeTruthy();
    const append = screen.getByRole("button", { name: "Append 1 stores" });
    expect(append.hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByLabelText(/Import them without those values/));
    await userEvent.click(append);
    await waitFor(() => expect(calls.some((call) => call.url.pathname.endsWith("/stores/append"))).toBe(true));
    const body = calls.find((call) => call.url.pathname.endsWith("/stores/append"))?.body as { stops: StopInput[] };
    expect(body.stops[0]).not.toHaveProperty("owner_email");
  });
});

describe("ImportWizard: fetch errors", () => {
  async function startAppend(extra: Parameters<typeof importRoutes>[0]) {
    const api = importRoutes(extra);
    renderWithProviders(<ImportWizard open appendTo={makeProject({ id: "p1" })} onClose={() => {}} />);
    const file = new File(["IBC#\n"], "ibc.csv", { type: "text/csv" });
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
    expect(await screen.findByRole("combobox", { name: "Field for column dma" })).toBeTruthy();
  });

  it("shows a store-field registry error with a retry", async () => {
    let fail = true;
    await startAppend({ "GET /api/config/store-fields": () => (fail ? jsonError(503, "unavailable") : STORE_FIELDS_FOR_TESTS) });
    const alert = await screen.findByRole("alert", undefined, { timeout: 4000 });
    expect(alert.textContent).toContain("Could not load the store fields: unavailable");
    fail = false;
    await userEvent.click(within(alert).getByRole("button", { name: /Retry/ }));
    expect(await screen.findByRole("combobox", { name: "Field for column dma" })).toBeTruthy();
  });
});

describe("ImportWizard: back to upload", () => {
  it("offers 'Continue to the columns' with the verified rows still loaded", async () => {
    importRoutes();
    renderWithProviders(<ImportWizard open appendTo={makeProject({ id: "p1" })} onClose={() => {}} />);
    await uploadSheet();
    await userEvent.click(screen.getByRole("button", { name: /Upload another file/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Continue to the columns/ }));
    expect(screen.getByRole("combobox", { name: "Field for column dma" })).toBeTruthy();
  });
});
