import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InstallerName } from "@/features/installers/InstallerName";
import { InstallersPage } from "@/features/installers/InstallersPage";
import { jsonError, mockApi, renderWithProviders } from "@/test/render";

const entry = (value: string, rest: Record<string, string> = {}) => ({ id: value, value, created_at: "", phone: "", phone2: "", email: "", email2: "", shipping_address: "", ...rest });

describe("Installers page", () => {
  it("lists installers with their details and flags the ones without a phone number", async () => {
    mockApi({
      "GET /api/lists/installers": () => ({
        items: [entry("Ann Lee", { phone: "555 010 2000", email: "ann@example.com", shipping_address: "1 Elm St, Macon, GA" }), entry("Bo")],
        next_cursor: null,
      }),
    });
    renderWithProviders(<InstallersPage />);
    const table = await screen.findByRole("table", { name: "Installers" });
    const ann = within(table).getByRole("row", { name: "Ann Lee" });
    expect(ann.textContent).toContain("555 010 2000");
    expect(ann.textContent).toContain("ann@example.com");
    expect(ann.textContent).toContain("1 Elm St, Macon, GA");
    expect(within(table).getByRole("row", { name: "Bo" }).textContent).toContain("No phone"); // typed somewhere, no details yet
    expect(screen.getByText("1 without a phone number")).toBeTruthy();
  });

  it("adding needs a name and a phone number, unless it is added without one on purpose", async () => {
    const sent: { path: string; body: Record<string, unknown> }[] = [];
    mockApi({
      "GET /api/lists/installers": () => ({ items: [], next_cursor: null }),
      "PUT /api/lists/installers/Sai%20Kumar": (url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        sent.push({ path: url.pathname, body });
        if (body.email === "taken@example.com") return jsonError(422, { message: "Sai Kumar is already an installer", fields: { name: "Already in the list" } });
        return entry("Sai Kumar", { phone: String(body.phone) });
      },
    });
    renderWithProviders(<InstallersPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Add installer/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /Add installer/ }));
    expect(within(dialog).getByText("A name is required")).toBeTruthy();
    expect(within(dialog).getByText(/A phone number is required/)).toBeTruthy();
    expect(sent).toHaveLength(0);
    await userEvent.type(within(dialog).getByLabelText("Full name *"), "Sai Kumar");
    await userEvent.type(within(dialog).getByLabelText("Email"), "taken@example.com");
    // No phone on purpose: allowed, and the server is told so.
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: /Add installer/ }));
    expect(await within(dialog).findByText("Already in the list")).toBeTruthy(); // the server's check, on its field
    expect(sent[0]?.body).toMatchObject({ phone: "", allow_no_phone: true, must_be_new: true });
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.type(within(dialog).getByLabelText("Phone number *"), "5550102000");
    await userEvent.clear(within(dialog).getByLabelText("Email"));
    await userEvent.type(within(dialog).getByLabelText("Current shipping address"), "9 Oak St");
    await userEvent.click(within(dialog).getByRole("button", { name: /Add installer/ }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.body).toEqual({ phone: "5550102000", phone2: "", email: "", email2: "", shipping_address: "9 Oak St", allow_no_phone: false, must_be_new: true });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("editing changes the full name and takes an additional phone and email", async () => {
    const sent: { path: string; body: Record<string, unknown> }[] = [];
    mockApi({
      "GET /api/lists/installers": () => ({ items: [entry("sijil")], next_cursor: null }),
      "PUT /api/lists/installers/sijil": (url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        sent.push({ path: url.pathname, body });
        return { ...entry("Sijil Thomas"), stores_renamed: 57, plans_renamed: 1 };
      },
    });
    renderWithProviders(<InstallersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit sijil" }));
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByLabelText("Full name *") as HTMLInputElement;
    expect(name.disabled).toBe(false);
    await userEvent.clear(name);
    await userEvent.type(name, "Sijil Thomas");
    expect(within(dialog).getByText(/Store records and active route plans that say sijil will say Sijil Thomas/)).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText("Phone number *"), "5550102000");
    await userEvent.click(within(dialog).getByRole("button", { name: /Add another phone number/ }));
    await userEvent.type(within(dialog).getByLabelText("Additional phone number"), "5550103000");
    await userEvent.click(within(dialog).getByRole("button", { name: /Add another email/ }));
    await userEvent.type(within(dialog).getByLabelText("Additional email"), "s2@example.com");
    await userEvent.click(within(dialog).getByRole("button", { name: /Save installer/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    // Sent to the installer's current name, with the new one in the body.
    expect(sent[0]?.body).toMatchObject({ new_name: "Sijil Thomas", phone: "5550102000", phone2: "5550103000", email2: "s2@example.com", must_be_new: false });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows what each installer did across projects, syncs matching names, and lists the names that match nobody", async () => {
    let synced = false;
    const { calls } = mockApi({
      "GET /api/lists/installers": () => ({ items: [entry("Carlos", { phone: "555 010 2000" })], next_cursor: null }),
      "GET /api/lists/installers/work": () => ({
        installers: [{ name: "Carlos", stores: 12, screens_done: 9, screens_upcoming: 4, to_sync: synced ? 0 : 3 }],
        unlisted: [{ name: "Zed", stores: 2, screens_done: 1, screens_upcoming: 1, to_sync: 0 }],
      }),
      "POST /api/lists/installers/sync": () => {
        synced = true;
        return { stores_updated: 3 };
      },
    });
    renderWithProviders(<InstallersPage />);
    const row = await screen.findByRole("row", { name: "Carlos" });
    await waitFor(() => expect(within(row).getAllByRole("cell").slice(4, 7).map((cell) => cell.textContent)).toEqual(["12", "9", "4"]));
    const other = screen.getByRole("listitem", { name: "Zed" });
    expect(other.textContent).toContain("2 stores · 1 done · 1 upcoming");
    await userEvent.click(screen.getByRole("button", { name: /Sync names \(3\)/ }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.url.pathname.endsWith("/installers/sync"))).toBe(true));
    await waitFor(() => expect((screen.getByRole("button", { name: /Sync names/ }) as HTMLButtonElement).disabled).toBe(true));
    // Adding one of them starts from its name.
    await userEvent.click(within(other).getByRole("button", { name: "Add Zed as an installer" }));
    expect((within(await screen.findByRole("dialog")).getByLabelText("Full name *") as HTMLInputElement).value).toBe("Zed");
  });

  it("a name on a record that matches no installer gets a mark; case and spacing do not matter", async () => {
    mockApi({ "GET /api/lists/installers": () => ({ items: [entry("Ann Lee", { phone: "555 010 2000" })], next_cursor: null }) });
    renderWithProviders(
      <>
        <InstallerName name="ann  lee" />
        <InstallerName name="Carlos" />
      </>,
    );
    expect(await screen.findByLabelText("Carlos is not in the Installers list")).toBeTruthy();
    expect(screen.queryByLabelText("ann  lee is not in the Installers list")).toBeNull();
  });
});
