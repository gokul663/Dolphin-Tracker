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

  it("header nav: Stores | Screens switch the list's view, the gear opens Settings", async () => {
    mockApi({ "GET /api/projects/p1": () => makeSummary() });
    renderProject("stores");
    const nav = await screen.findByRole("navigation", { name: "Project sections" });
    expect(within(nav).getByRole("button", { name: "Stores" }).getAttribute("aria-current")).toBe("page");
    await userEvent.click(within(nav).getByRole("button", { name: "Screens" }));
    expect(within(nav).getByRole("button", { name: "Screens" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("button", { name: "Stores" }).getAttribute("aria-current")).toBeNull();
    await userEvent.click(within(nav).getByRole("link", { name: "Settings" }));
    expect(await screen.findByLabelText("Hardware costs")).toBeTruthy();
    expect(within(nav).getByRole("button", { name: "Screens" }).getAttribute("aria-current")).toBeNull();
  });

  it("explains a missing project", async () => {
    mockApi({ "GET /api/projects/p1": () => jsonError(404, "Project p1 not found") });
    renderProject();
    expect(await screen.findByText("This project does not exist.")).toBeTruthy();
  });
});

describe("Settings tab", () => {
  it("lists the uploaded sheets with a download each, and offers to upload another", async () => {
    mockApi({
      "GET /api/projects/p1": () => makeSummary(),
      "GET /api/projects/p1/uploads": () => ({
        items: [
          { id: "j2", filename: "wave-2.xlsx", key: "projects/p1/uploads/j2/wave-2.xlsx", uploaded_at: "2026-11-16T10:00:00+00:00", kind: "append", size: 204800, submitted: 700, added: 200, skipped: 500, download_url: "https://files.example/wave-2.xlsx" },
          { id: "j1", filename: "wave-1.xlsx", key: "projects/p1/uploads/j1/wave-1.xlsx", uploaded_at: "2026-10-01T09:00:00+00:00", kind: "create", size: 102400, submitted: 500, added: 500, skipped: 0, download_url: "https://files.example/wave-1.xlsx" },
        ],
      }),
    });
    renderProject();
    const list = await screen.findByRole("list", { name: "Uploaded sheets" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => within(row).getByText(/\.xlsx$/).textContent)).toEqual(["wave-2.xlsx", "wave-1.xlsx"]);
    expect(rows[0]!.textContent).toContain("200 added · 500 already there");
    expect(rows[1]!.textContent).toContain("created the project");
    expect(within(rows[0]!).getByRole("link", { name: /Download/ }).getAttribute("href")).toBe("https://files.example/wave-2.xlsx");
    expect(screen.getByRole("button", { name: /Upload a sheet/ })).toBeTruthy();
  });

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

  it("hardware prices: a stick, then sizes each with one cost and its types with a default; saved together", async () => {
    const { calls } = mockApi({
      "GET /api/projects/p1": () => makeSummary(),
      "PATCH /api/projects/p1": () => makeProject(),
    });
    renderProject();
    const card = await screen.findByLabelText("Hardware costs");
    await userEvent.type(within(card).getByLabelText(/Stick/), "40");
    expect(within(card).getByText("No screens priced yet.")).toBeTruthy();
    // Add a size with its cost, then its types under it: the cost belongs to the size, not to a type.
    await userEvent.click(within(card).getByRole("button", { name: /Add size/ }));
    await userEvent.type(within(card).getByLabelText("Size"), "24");
    const size24 = within(card).getByRole("listitem", { name: 'Screens of 24"' });
    await userEvent.type(within(size24).getByLabelText('Cost of 24"'), "abc");
    expect(within(size24).getByText("Enter an amount, e.g. 120 or 120.50")).toBeTruthy();
    expect(within(card).getByRole("button", { name: /Save prices/ }).hasAttribute("disabled")).toBe(true);
    await userEvent.clear(within(size24).getByLabelText('Cost of 24"'));
    await userEvent.type(within(size24).getByLabelText('Cost of 24"'), "120.50");
    await userEvent.click(within(size24).getByRole("button", { name: 'Add a type to 24"' }));
    await userEvent.type(within(size24).getByLabelText('Type 1 of 24"'), "Dolphin");
    await userEvent.click(within(size24).getByRole("button", { name: 'Add a type to 24"' }));
    await userEvent.type(within(size24).getByLabelText('Type 2 of 24"'), "dolphin");
    expect(within(size24).getByText("This type is already listed for this size")).toBeTruthy();
    await userEvent.clear(within(size24).getByLabelText('Type 2 of 24"'));
    await userEvent.type(within(size24).getByLabelText('Type 2 of 24"'), "Dell");
    expect(within(size24).queryByLabelText(/Cost of type/)).toBeNull(); // no cost per type
    // The first type of a size is its default until another is marked.
    expect((within(size24).getByRole("radio", { name: 'Dolphin is the default of 24"' }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(within(size24).getByRole("radio", { name: 'Dell is the default of 24"' }));
    // A size may have no types: it is still priced.
    await userEvent.click(within(card).getByRole("button", { name: /Add size/ }));
    await userEvent.type(within(card).getAllByLabelText("Size")[1]!, "43");
    await userEvent.type(within(card).getByLabelText('Cost of 43"'), "300");
    // Mounts: a size first, then its wall mount and (if there is one) its ceiling mount.
    expect(within(card).getByText("No mounts priced yet.")).toBeTruthy();
    await userEvent.click(within(card).getByRole("button", { name: "Add a mount size" }));
    await userEvent.type(within(card).getByLabelText("Mount size new size"), "24");
    const mount24 = within(card).getByRole("listitem", { name: 'Mounts of 24"' });
    await userEvent.type(within(mount24).getByLabelText('Wall mount of 24"'), "15");
    await userEvent.click(within(card).getByRole("button", { name: "Add a mount size" }));
    await userEvent.type(within(card).getByLabelText("Mount size new size"), "43");
    const mount43 = within(card).getByRole("listitem", { name: 'Mounts of 43"' });
    await userEvent.type(within(mount43).getByLabelText('Wall mount of 43"'), "30");
    await userEvent.type(within(mount43).getByLabelText('Ceiling mount of 43"'), "55.50");
    await userEvent.click(within(card).getByRole("button", { name: /Save prices/ }));
    await waitFor(() => expect(body(calls, "PATCH", "/api/projects/p1")).toEqual({
      hardware_costs: {
        stick: 40,
        screens: [
          { size: '24"', type: "Dolphin", cost: 120.5, is_default: false },
          { size: '24"', type: "Dell", cost: 120.5, is_default: true },
          { size: '43"', type: "", cost: 300, is_default: true },
        ],
        mounts: [{ size: '24"', wall: 15, ceiling: null }, { size: '43"', wall: 30, ceiling: 55.5 }],
      },
      expected_version: 1,
    }));
  });

  it("screen cost sheet: upload previews what it would change, Apply writes it", async () => {
    const row = (over: Record<string, unknown>) => ({
      row: 2, dd_code: "DD-ONE", external_id: "X1", note: "", matched: true, store_uid: "u1", store_name: "Alpha Mart", store_external_id: "X1",
      ibc_differs: false, size_from: '24"', size_to: '43"', dolphin_from: true, dolphin_to: false, changes: true, sheet_cost: 175, our_cost: 175,
      cost_differs: false, problem: "", stick_count: 1, screen_count: 0, ...over,
    });
    const rows = [row({}), row({ row: 3, dd_code: "DD-TWO", size_to: '24"', dolphin_to: true, changes: false, sheet_cost: 500, our_cost: 475, cost_differs: true }),
      row({ row: 4, dd_code: "DD-NOWHERE", matched: false, changes: false, problem: "This DD code is on no screen of the project" })];
    const sent: Record<string, unknown>[] = [];
    mockApi({
      "GET /api/projects/p1": () => makeSummary(),
      "POST /api/projects/p1/screen-sheet": (_url, init) => {
        const sentBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        sent.push(sentBody);
        return { rows, matched: 2, changing: sentBody.apply ? 0 : 1, unmatched: 1, cost_differs: 1, total_cost: 650, unpriced: 0, applied: Boolean(sentBody.apply), screens_updated: sentBody.apply ? 1 : 0 };
      },
    });
    renderProject();
    const card = await screen.findByLabelText("Screen cost sheet");
    await userEvent.upload(within(card).getByLabelText("Screen cost sheet file"), new File(["Venue ID,Screen Size\nDD-ONE,43"], "costs.csv", { type: "text/csv" }));
    await waitFor(() => expect(within(card).getByRole("status").textContent).toContain("2 of 3 rows match a screen"));
    expect(sent[0]).toMatchObject({ filename: "costs.csv", apply: false });
    expect(atob(String(sent[0]!.content_base64))).toContain("DD-ONE,43");
    expect(within(card).getByLabelText("Worked-out cost").textContent).toBe("$650");
    // The rows to change show first: size and owner, before → after.
    const table = within(card).getByRole("table", { name: "Sheet rows" });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByRole("row", { name: "DD-ONE" }).textContent).toContain('24" → 43"');
    expect(within(table).getByRole("row", { name: "DD-ONE" }).textContent).toContain("Dolphin → Store");
    await userEvent.click(within(card).getByRole("tab", { name: "Cost differs 1" }));
    expect(within(card).getByRole("row", { name: "DD-TWO" }).textContent).toContain("$500$475");
    await userEvent.click(within(card).getByRole("tab", { name: "Not in the project 1" }));
    expect(within(card).getByRole("row", { name: "DD-NOWHERE" }).textContent).toContain("on no screen of the project");
    await userEvent.click(within(card).getByRole("button", { name: "Apply 1 change" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ filename: "costs.csv", apply: true });
    expect(await within(card).findByText("applied")).toBeTruthy();
  });
});
