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
  summary: { total: 4, valid: 3, needs_review: 1, invalid: 0, duplicates: 1, known: 0 }, pa_names: ["North"],
  rows: [
    row(0, { venue_status: "Completed", details: { dma: "ATL" }, fields: { notes: "side door" },
             screens: [{ stick_number: "S1", venue_id: "V1", status: "Completed" }] }),
    row(1, { external_id: "", problems: { external_id: "ExtID is required" } }),
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
  const file = new File(["ExtID,Store Name,Store Address\n"], "ibc.csv", { type: "text/csv" });
  await userEvent.upload(screen.getByLabelText("Spreadsheet file"), file);
  await userEvent.click(screen.getByRole("button", { name: /Upload and verify/ }));
  await screen.findByRole("combobox", { name: "Field for column dma" }, { timeout: 4000 }); // the Columns step
}

async function fixReviewRows() {
  await userEvent.type(screen.getByLabelText("ExtID, row 2"), "ibc-new");
  await userEvent.click(screen.getByRole("combobox", { name: "Suggestions, row 3" }));
  await userEvent.click(await screen.findByRole("option", { name: "2 Main St NW, Atlanta, GA, USA" }));
  await waitFor(() => expect(screen.getByText("3 ready · 1 excluded")).toBeTruthy());
}

/** Only the name, the type (preset) and the single PA's name are required. */
async function fillDetails() {
  await userEvent.type(screen.getByLabelText("Project name *"), "Wave 3");
  await userEvent.type(screen.getByLabelText("PA name *"), "North");
  await userEvent.type(screen.getByLabelText("PA %"), "40");
}

describe("ImportWizard: new project", () => {
  it("details → upload → columns (re-point) → review (duplicates, fixes) → create with the mapping", async () => {
    const { calls } = importRoutes({
      "POST /api/projects": () => ({ project: makeProject({ id: "new1", name: "Wave 3" }), skipped: [] }),
    });
    renderWithProviders(<ImportWizard open onClose={() => {}} />);

    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByText("Project name is required")).toBeTruthy();
    expect(screen.getByText("PA name is required")).toBeTruthy();
    expect(screen.queryByLabelText("Field agent")).toBeNull(); // behind "Has a field agent"
    expect(screen.queryByLabelText(/Stops per day/)).toBeNull(); // installers and the cap belong to route plans
    expect(screen.queryByLabelText(/Installer/)).toBeNull();
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
    const search = screen.getByRole("textbox", { name: "Search fields for column notes" });
    await userEvent.type(search, "comment");
    expect(screen.queryByRole("option", { name: /^DMA/ })).toBeNull(); // filtered out
    expect((search as HTMLInputElement).value).toBe("comment"); // typing stays in the box
    await userEvent.click(screen.getByRole("option", { name: "Installation comments" }));
    await waitFor(() => expect(calls.find((call) => call.url.pathname === "/api/jobs/j1/mapping")?.body).toEqual({
      mapping: { ...RESULT.mapping, notes: "installation_notes" },
    }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Field for column notes" }).textContent).toContain("Installation comments"));

    // Review: the duplicate is excluded with its reason; fix the rest.
    await userEvent.click(screen.getByRole("button", { name: /Next: review 4 rows/ }));
    await userEvent.click(screen.getByRole("button", { name: /1 duplicates/ }));
    expect(screen.getByRole("note").textContent).toBe("Duplicate: Same ExtID as row 1");
    expect(screen.getByRole("checkbox", { name: "Exclude row 4" }).hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: /4 all rows/ }));
    expect(screen.getByLabelText("Screens, row 1").textContent).toBe("1 screen · S1/V1");
    await fixReviewRows();
    await userEvent.type(screen.getByLabelText("Review notes, row 3"), "store name not confirmed");
    await userEvent.click(screen.getByRole("button", { name: "Create project with 3 stores" }));

    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.url.pathname === "/api/projects")).toBe(true));
    const body = calls.find((call) => call.method === "POST" && call.url.pathname === "/api/projects")?.body as {
      stops: StopInput[]; import_mapping: Record<string, string>; pa: string;
      pa_percentage: number | null; dolphin_percentage: number | null; fa_percentage: number | null;
    };
    expect(body).toMatchObject({ pa_percentage: 40, dolphin_percentage: null, fa_percentage: null });
    expect(body).not.toHaveProperty("installers");
    expect(body).not.toHaveProperty("stops_per_day");
    expect(body.import_mapping).toEqual(REMAPPED.mapping); // saved on the project for its next sheet
    expect(body.pa).toBe("North");
    expect(body.stops.map((stop) => stop.external_id)).toEqual(["IBC-0", "IBC-NEW", "IBC-2"]); // no duplicate
    expect(body.stops[0]).toMatchObject({
      dma: "ATL", installation_notes: "side door", fields: {}, screens: [{ stick_number: "S1", venue_id: "V1", status: "Completed" }],
    });
    expect(body.stops[2]).toMatchObject({ addr: "2 Main St NW", lat: 33.72, review_notes: "store name not confirmed" });
    expect(body.stops[0]?.review_notes).toBe(""); // nothing typed for it
  });

  it("several PAs: no PA name, each store brings its own from the sheet", async () => {
    const noPa = { ...REMAPPED, rows: REMAPPED.rows.map((r) => (r.index === 2 ? { ...r, pa: "" } : r)) };
    const { calls } = importRoutes({ "POST /api/jobs/j1/mapping": () => noPa });
    renderWithProviders(<ImportWizard open onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText("Project name *"), "Wave 3");
    await userEvent.click(screen.getByRole("checkbox", { name: /Single PA/ }));
    expect(screen.queryByLabelText("PA name *")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await uploadSheet();
    await userEvent.click(screen.getByRole("combobox", { name: "Field for column notes" }));
    await userEvent.click(await screen.findByRole("option", { name: "Installation comments" }));
    await waitFor(() => expect(calls.some((call) => call.url.pathname === "/api/jobs/j1/mapping")).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: /Next: review 4 rows/ }));
    await fixReviewRows();
    expect(screen.getByRole("alert").textContent).toContain("Some stores have no PA");
    expect(screen.getByRole("button", { name: "Create project with 3 stores" }).hasAttribute("disabled")).toBe(true);
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
    expect(screen.getByText("Store 0 · ExtID IBC-0")).toBeTruthy();
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
    const file = new File(["ExtID\n"], "ibc.csv", { type: "text/csv" });
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

describe("ImportWizard: screens in the review step", () => {
  it("swaps a stick number and DD code that came in each other's column, and lets each screen be edited", async () => {
    const swappedResult: ImportResult = {
      ...RESULT,
      rows: RESULT.rows.map((r) =>
        r.index === 0 ? { ...r, screens: [{ stick_number: "DD-H6WKL4", venue_id: "DD-002-01356", status: "Completed" }] } : r,
      ),
    };
    const { calls } = importRoutes({
      "GET /api/jobs/j1/result": () => swappedResult,
      "POST /api/projects": () => ({ project: makeProject({ id: "new3", name: "Wave 3" }), skipped: [] }),
    });
    renderWithProviders(<ImportWizard open onClose={() => {}} />);
    await fillDetails();
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await uploadSheet();
    await userEvent.click(screen.getByRole("button", { name: /Next: review 4 rows/ }));
    await userEvent.click(screen.getByRole("button", { name: /1 with DD codes to check/ }));
    expect(screen.getByRole("note").textContent).toContain("Stick number and DD code look swapped");
    await userEvent.click(screen.getByRole("button", { name: "Swap stick number and DD code on 1 row" }));
    expect(screen.getByLabelText("Screens, row 1").textContent).toBe("1 screen · DD-002-01356/DD-H6WKL4");
    expect(screen.queryByRole("note")).toBeNull();

    // Edit the screens by hand: a code in another format is pointed out, and a screen can be added.
    await userEvent.click(screen.getByRole("button", { name: "Edit screens, row 1" }));
    const code = screen.getByLabelText("DD code 1, row 1");
    await userEvent.clear(code);
    await userEvent.type(code, "DD-H6WKL");
    expect(screen.getByLabelText("DD code format, row 1").textContent).toContain("DD-H6WKL");
    await userEvent.type(code, "4");
    expect(screen.queryByLabelText("DD code format, row 1")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Add a screen, row 1" }));
    await userEvent.type(screen.getByLabelText("DD code 2, row 1"), "DD_NEW123");

    await userEvent.click(screen.getByRole("button", { name: /4 all rows/ }));
    await fixReviewRows();
    await userEvent.click(screen.getByRole("button", { name: "Create project with 3 stores" }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.url.pathname === "/api/projects")).toBe(true));
    const body = calls.find((call) => call.method === "POST" && call.url.pathname === "/api/projects")?.body as { stops: StopInput[] };
    expect(body.stops[0]?.screens).toEqual([
      { stick_number: "DD-002-01356", venue_id: "DD-H6WKL4", status: "Completed" },
      { stick_number: "", venue_id: "DD_NEW123", status: "Completed" }, // a new screen takes the row's sheet status
    ]);
  });
});

describe("ImportWizard: stores we already know", () => {
  it("sends the PA with the upload and says what was reused on the row", async () => {
    const known: ImportResult = {
      ...RESULT,
      rows: RESULT.rows.map((r) =>
        r.index === 0
          ? { ...r, coordinates_source: "known", verified_by: ["tracker"], reused: "Address from project Wave 1 · 2 DD codes from the Dolphin data",
              screens: [{ stick_number: "SN-1", venue_id: "DD_AAA111", status: "Completed" }, { stick_number: "SN-2", venue_id: "DD_AAA222", status: "Offline" }] }
          : r,
      ),
    };
    const { calls } = importRoutes({ "GET /api/jobs/j1/result": () => known });
    renderWithProviders(<ImportWizard open onClose={() => {}} />);
    await fillDetails();
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await uploadSheet();
    expect(calls.find((call) => call.url.pathname === "/api/jobs/imports")?.body).toMatchObject({ pa: "North" });
    await userEvent.click(screen.getByRole("button", { name: /Next: review 4 rows/ }));
    await userEvent.click(screen.getByRole("button", { name: /4 all rows/ }));
    expect(screen.getByLabelText("Already known, row 1").textContent).toBe("Address from project Wave 1 · 2 DD codes from the Dolphin data");
    expect(screen.getByLabelText("Screens, row 1").textContent).toBe("2 screens · SN-1/DD_AAA111, SN-2/DD_AAA222");
    expect(screen.queryByLabelText("Already known, row 2")).toBeNull();
  });
});

describe("ImportWizard: from the Dolphin data", () => {
  it("creates the project with no sheet, then builds its stores from the PA's records", async () => {
    const { calls } = mockApi({
      "GET /api/device-data/pas": () => ({ date: "2026-11-09", pas: ["IBC", "North"] }),
      "POST /api/projects": () => ({ project: makeProject({ id: "new2", name: "Wave 4" }), skipped: [] }),
      "POST /api/projects/new2/device-sync/populate": () => ({
        stores_added: 12, sync: { synced: true, state: null, stores_updated: 12 },
      }),
    });
    renderWithProviders(<ImportWizard open onClose={() => {}} />);

    await userEvent.type(screen.getByLabelText("Project name *"), "Wave 4");
    await userEvent.click(screen.getByRole("radio", { name: /Dolphin data only/ }));
    expect(screen.queryByText(/Upload the store list/)).toBeNull(); // no upload, columns or review steps
    await userEvent.click(screen.getByRole("button", { name: /Create project from the Dolphin data/ }));
    expect(calls.some((call) => call.method === "POST" && call.url.pathname === "/api/projects")).toBe(false);

    await userEvent.type(screen.getByLabelText("PA in the Dolphin data *"), "IBC");
    await userEvent.click(screen.getByRole("button", { name: /Create project from the Dolphin data/ }));
    await waitFor(() =>
      expect(calls.some((call) => call.url.pathname === "/api/projects/new2/device-sync/populate")).toBe(true),
    );
    const body = calls.find((call) => call.method === "POST" && call.url.pathname === "/api/projects")?.body as {
      device_pa: string; pa: string; stops?: unknown;
    };
    expect(body.device_pa).toBe("IBC");
    expect(body.pa).toBe("IBC"); // the PA name defaults to the Dolphin data's PA
    expect(body.stops).toBeUndefined();
  });
});
