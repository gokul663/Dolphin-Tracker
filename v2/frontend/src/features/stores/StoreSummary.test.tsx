import { describe, expect, it } from "vitest";
import { useState } from "react";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toRows } from "@/features/stores/ScreensEditor";
import { computedMountsUsed, computedMountsUsedByPiece, StoreSummary, type SummaryDraft } from "@/features/stores/StoreSummary";
import { makeScreen, makeStop } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render";

const NO_COUNTS = { committed_dolphin_screens: "", committed_store_tvs: "", wall_mounts_needed: "", wall_24_mounts_needed: "", ceiling_mounts_needed: "", tv_mounts_needed: "", mounts_used: "" };

const PRICES = { stick: 40 as number | null, screens: [{ size: '24"', type: "Dolphin", cost: 120 }, { size: '43"', type: "Dolphin", cost: 300 }] };

function Harness({ initial, costs = PRICES }: { initial: SummaryDraft; costs?: typeof PRICES }) {
  const [draft, setDraft] = useState(initial);
  const [editing, setEditing] = useState(false);
  return (
    <StoreSummary
      draft={draft}
      costs={costs}
      technicians={["Sai"]}
      editingCommitted={editing}
      onEditCommitted={setEditing}
      onCount={(key, text) => setDraft((current) => ({ ...current, counts: { ...current.counts, [key]: text } }))}
      onTechnician={(technician) => setDraft((current) => ({ ...current, technician }))}
      onInstallType={(installType) => setDraft((current) => ({ ...current, installType }))}
    />
  );
}

const draftOf = (screens: ReturnType<typeof makeScreen>[], counts: Partial<SummaryDraft["counts"]> = {}): SummaryDraft => ({
  counts: { ...NO_COUNTS, ...counts },
  errors: {},
  rows: toRows(makeStop({ screens })),
  technician: "",
  installType: "",
});

describe("StoreSummary", () => {
  it("committed and installed show screens and TVs apart", async () => {
    renderWithProviders(
      <Harness initial={draftOf([makeScreen({ id: "a", status: "Completed" }), makeScreen({ id: "b", status: "Completed", is_dolphin_screen: false })], { committed_dolphin_screens: "2", committed_store_tvs: "1" })} />,
    );
    expect(screen.getByLabelText("Committed total").textContent).toBe("3");
    expect(screen.getByLabelText("Installed screens").textContent).toBe("1");
    expect(screen.getByLabelText("Installed TVs").textContent).toBe("1");
    expect(screen.getByText("2 of 3 committed")).toBeTruthy();
  });

  it("mounts needed: worked out from the Upcoming screens' mounts, with nothing to type", () => {
    renderWithProviders(
      <Harness
        initial={draftOf([
          makeScreen({ id: "a", has_mount: true, screen_size: '24"' }),
          makeScreen({ id: "b", has_mount: true, screen_size: '43"' }),
          makeScreen({ id: "c", has_mount: true, has_ceiling_mount: true, screen_size: '24"' }),
          makeScreen({ id: "d", has_mount: true, screen_size: '24"', status: "Completed" }), // installed: nothing to bring
          makeScreen({ id: "e" }), // no mount picked
        ])}
      />,
    );
    const mounts = screen.getByRole("region", { name: "Mounts" });
    expect(within(mounts).getByLabelText("Mounts needed").textContent).toBe("3"); // wall 24, wall, ceiling
    expect(within(mounts).getByLabelText("Mounts used").textContent).toBe("1");
    expect(within(mounts).queryAllByRole("textbox")).toEqual([]); // two numbers, no boxes
    expect(within(mounts).queryByLabelText(/override/i)).toBeNull();
  });

  it("mounts: Not Registered still needs its mount; installed screens (Needs More Work too) have used theirs", () => {
    renderWithProviders(
      <Harness
        initial={draftOf([
          makeScreen({ id: "a", has_mount: true, status: "Not Registered" }),
          makeScreen({ id: "b", has_mount: true, status: "Serviced - Needs More Work" }),
          makeScreen({ id: "c", has_mount: true, status: "Completed" }),
          makeScreen({ id: "d", has_mount: true, status: "Offline" }),
          makeScreen({ id: "e", has_mount: true, status: "Cancelled" }), // neither
          makeScreen({ id: "f", status: "Completed" }), // no mount picked
        ])}
      />,
    );
    const mounts = screen.getByRole("region", { name: "Mounts" });
    expect(within(mounts).getByLabelText("Mounts needed").textContent).toBe("1");
    expect(within(mounts).getByLabelText("Mounts used").textContent).toBe("3");
  });

  it("counts an Offline screen as installed", () => {
    renderWithProviders(<Harness initial={draftOf([makeScreen({ id: "a", status: "Offline" })], { committed_dolphin_screens: "1" })} />);
    expect(screen.getByLabelText("Installed total").textContent).toBe("1");
    expect(screen.getByLabelText("Fulfilled")).toBeTruthy();
  });

  it("install type: Technician by default; Self and Rep show a pill instead of the technician box", async () => {
    renderWithProviders(<Harness initial={{ ...draftOf([makeScreen({ id: "a" })]), technician: "Sai" }} />);
    expect(screen.getByRole("combobox", { name: "Install type" }).textContent).toBe("Technician");
    for (const [choice, pill] of [["Self install", "Self"], ["Rep install", "Rep"]]) {
      await userEvent.click(screen.getByRole("combobox", { name: "Install type" }));
      await userEvent.click(await screen.findByRole("option", { name: choice }));
      expect(screen.queryByLabelText("Technician")).toBeNull();
      expect(screen.getByLabelText(`Technician: ${choice.toLowerCase()}`).textContent).toBe(pill);
    }
    await userEvent.click(screen.getByRole("combobox", { name: "Install type" }));
    await userEvent.click(await screen.findByRole("option", { name: "Technician" }));
    expect((screen.getByLabelText("Technician") as HTMLInputElement).value).toBe("Sai"); // the name was kept
  });

  it("hardware cost: a stick per installed screen, plus the screen for a Dolphin TV at its size's price", () => {
    renderWithProviders(
      <Harness
        initial={draftOf([
          makeScreen({ id: "a", status: "Completed", is_dolphin_screen: true, screen_size: '24"' }),
          makeScreen({ id: "b", status: "Offline", is_dolphin_screen: true, screen_size: '43"' }),
          makeScreen({ id: "c", status: "Completed", is_dolphin_screen: false, screen_size: '55"' }), // store TV: stick only
          makeScreen({ id: "d", status: "Upcoming", is_dolphin_screen: true, screen_size: '24"' }), // not installed
        ])}
      />,
    );
    // 3 sticks × 40 + 120 (24") + 300 (43") = 540
    expect(screen.getByLabelText("Hardware cost").textContent).toContain("$540");
    const lines = within(screen.getByLabelText("Hardware cost lines")).getAllByRole("listitem").map((item) => item.textContent);
    expect(lines).toEqual(["3 × Sticks$120", '1 × 24" Dolphin screens$120', '1 × 43" Dolphin screens$300']);
  });

  it("a screen with no type chosen is priced as its size's default in Settings", () => {
    const costs = { stick: 40, screens: [{ size: '24"', type: "Dell", cost: 95 }, { size: '24"', type: "Dolphin", cost: 120, is_default: true }] };
    renderWithProviders(
      <Harness
        costs={costs}
        initial={draftOf([
          makeScreen({ id: "a", status: "Completed", screen_size: '24"' }), // entered before types existed
          makeScreen({ id: "b", status: "Completed", screen_size: '24"', screen_type: "Dell" }),
        ])}
      />,
    );
    const lines = within(screen.getByLabelText("Hardware cost lines")).getAllByRole("listitem").map((item) => item.textContent);
    expect(lines).toEqual(["2 × Sticks$80", '1 × 24" Dell screens$95', '1 × 24" Dolphin screens$120']);
  });

  it("the technician suggestions open in the app's own list and narrow as you type", async () => {
    renderWithProviders(<Harness initial={{ ...draftOf([makeScreen()]), technician: "" }} />);
    const box = screen.getByLabelText("Technician");
    await userEvent.click(box);
    expect(within(await screen.findByRole("listbox")).getAllByRole("option").map((option) => option.textContent)).toEqual(["Sai"]);
    await userEvent.type(box, "zz");
    expect(screen.queryByRole("listbox")).toBeNull(); // nothing matches: no list
    await userEvent.clear(box);
    await userEvent.click(await screen.findByRole("option", { name: "Sai" }));
    expect((box as HTMLInputElement).value).toBe("Sai");
    expect(screen.queryByRole("listbox")).toBeNull(); // picked: closed
  });

  it("hardware cost asks for a price that is not set yet", () => {
    renderWithProviders(<Harness initial={draftOf([makeScreen({ id: "a", status: "Completed", is_dolphin_screen: true, screen_size: '50"' })])} />);
    expect(screen.getByLabelText("Hardware cost").textContent).toContain('Set the 50" Dolphin screen price in Settings');
  });
});

describe("StoreSummary cards", () => {
  const card = () => screen.getByRole("region", { name: "Screens: committed and installed" });

  it("one Screens card holds committed and installed, and turns green once installed reaches committed (equal or more)", async () => {
    const rows = [makeScreen({ id: "a", status: "Completed" }), makeScreen({ id: "b", status: "Completed", is_dolphin_screen: false })];
    renderWithProviders(<Harness initial={draftOf(rows, { committed_dolphin_screens: "2", committed_store_tvs: "1" })} />);
    expect(within(card()).getByRole("group", { name: "Committed" })).toBeTruthy();
    expect(within(card()).getByRole("group", { name: "Installed" })).toBeTruthy();
    expect(within(card()).getByLabelText("Installed total").textContent).toBe("2");
    expect(card().className).not.toContain("bg-green-50"); // 2 of 3: under
    expect(within(card()).queryByLabelText("Fulfilled")).toBeNull();
    await userEvent.click(within(card()).getByRole("button", { name: "Edit committed counts" }));
    // Equal: 2 committed in all, 2 installed.
    await userEvent.clear(screen.getByLabelText("TVs"));
    await userEvent.type(screen.getByLabelText("TVs"), "0");
    expect(card().className).toContain("bg-green-50");
    expect(within(card()).getByLabelText("Fulfilled")).toBeTruthy();
    expect(within(card()).getByText("2 of 2 committed")).toBeTruthy();
    // More installed than committed: still met, still green (as the stores table's check).
    await userEvent.clear(screen.getByLabelText("Screens"));
    await userEvent.type(screen.getByLabelText("Screens"), "1");
    expect(card().className).toContain("bg-green-50");
    expect(within(card()).getByLabelText("Fulfilled")).toBeTruthy();
    expect(within(card()).getByText("2 of 1 committed")).toBeTruthy();
  });

  it("committed reads as numbers until Edit; Edit shows the boxes (focused), View goes back keeping the draft", async () => {
    renderWithProviders(<Harness initial={draftOf([makeScreen({ id: "a" })], { committed_dolphin_screens: "4", committed_store_tvs: "" })} />);
    expect(within(card()).getByLabelText("Committed screens").textContent).toBe("4");
    expect(within(card()).getByLabelText("Committed TVs").textContent).toBe("0"); // blank counts as 0
    expect(within(card()).queryByRole("textbox")).toBeNull();
    await userEvent.click(within(card()).getByRole("button", { name: "Edit committed counts" }));
    const boxes = within(card()).getByLabelText("Screens") as HTMLInputElement;
    expect(document.activeElement).toBe(boxes); // straight into the first box
    await userEvent.clear(boxes);
    await userEvent.type(boxes, "6");
    await userEvent.click(within(card()).getByRole("button", { name: "View committed counts" }));
    expect(within(card()).queryByRole("textbox")).toBeNull();
    expect(within(card()).getByLabelText("Committed screens").textContent).toBe("6"); // the draft stays
  });

  it("a committed count that is not valid keeps the boxes open with the message", () => {
    renderWithProviders(
      <Harness initial={{ ...draftOf([makeScreen({ id: "a" })], { committed_store_tvs: "x" }), errors: { committed_store_tvs: "Store TVs (committed): must be a whole number of 0 or more" } }} />,
    );
    const tvs = within(card()).getByLabelText("TVs");
    expect(tvs.getAttribute("aria-invalid")).toBe("true");
    expect(within(card()).getByText("Store TVs (committed): must be a whole number of 0 or more")).toBeTruthy();
    expect(within(card()).getByRole("button", { name: "View committed counts" }).hasAttribute("disabled")).toBe(true);
  });

  it("a viewer sees the committed counts with no Edit", () => {
    renderWithProviders(<Harness initial={draftOf([makeScreen({ id: "a" })], { committed_dolphin_screens: "2" })} />, { role: "viewer" });
    expect(within(card()).getByLabelText("Committed screens").textContent).toBe("2");
    expect(within(card()).queryByRole("button", { name: /committed counts/ })).toBeNull();
  });

  it("a blank committed count is 0: anything installed meets it (green), nothing installed does not", () => {
    const { unmount } = renderWithProviders(<Harness initial={draftOf([makeScreen({ id: "a", status: "Completed" })])} />);
    expect(card().className).toContain("bg-green-50");
    expect(within(card()).getByText("1 of 0 committed")).toBeTruthy();
    expect(within(card()).getByLabelText("Committed screens").textContent).toBe("0");
    expect(within(card()).getByLabelText("Committed total").textContent).toBe("0");
    unmount();
    renderWithProviders(<Harness initial={draftOf([makeScreen({ id: "a", status: "Upcoming" })])} />);
    expect(card().className).not.toContain("bg-green-50");
  });

  it("hardware cost is its own card, second in the row, and absent when the project hides it", () => {
    const rows = [makeScreen({ id: "a", status: "Completed", screen_size: '24"' })];
    const { unmount } = renderWithProviders(<Harness initial={draftOf(rows)} />);
    const cards = within(screen.getByLabelText("Store summary")).getAllByRole("region").map((region) => region.getAttribute("aria-label"));
    expect(cards).toEqual(["Screens: committed and installed", "Hardware cost", "Mounts", "Assignment"]);
    unmount();
    renderWithProviders(<Harness initial={draftOf(rows)} costs={{ ...PRICES, hidden: true } as typeof PRICES} />);
    const three = within(screen.getByLabelText("Store summary")).getAllByRole("region").map((region) => region.getAttribute("aria-label"));
    expect(three).toEqual(["Screens: committed and installed", "Mounts", "Assignment"]);
    expect(screen.queryByLabelText("Hardware cost")).toBeNull();
  });

  it("mounts needed and used are each split per piece: Wall 24″, Wall, Ceiling", () => {
    renderWithProviders(
      <Harness
        initial={draftOf([
          makeScreen({ id: "a", has_mount: true, screen_size: '24"' }), // needed, wall 24
          makeScreen({ id: "b", has_mount: true, screen_size: '43"' }), // needed, wall
          makeScreen({ id: "c", has_mount: true, has_ceiling_mount: true, screen_size: '43"' }), // needed, ceiling
          makeScreen({ id: "d", has_mount: true, screen_size: "", status: "Completed" }), // used, wall 24 (no size)
          makeScreen({ id: "e", has_mount: true, screen_size: '55"', status: "Offline" }), // used, wall
          makeScreen({ id: "f", has_mount: true, has_ceiling_mount: true, status: "Serviced - Needs More Work" }), // used, ceiling
          makeScreen({ id: "g", has_mount: true, has_ceiling_mount: true, status: "Completed" }), // used, ceiling
        ])}
      />,
    );
    const mounts = screen.getByRole("region", { name: "Mounts" });
    const value = (label: string) => within(mounts).getByLabelText(label).textContent;
    expect([value("Mounts needed"), value("Mounts needed: Wall 24″"), value("Mounts needed: Wall"), value("Mounts needed: Ceiling")]).toEqual(["3", "1", "1", "1"]);
    expect([value("Mounts used"), value("Mounts used: Wall 24″"), value("Mounts used: Wall"), value("Mounts used: Ceiling")]).toEqual(["4", "1", "1", "2"]);
  });
});

describe("computedMountsUsedByPiece", () => {
  it("sorts installed screens with a mount into the pieces, totalling computedMountsUsed", () => {
    const rows = toRows(
      makeStop({
        screens: [
          makeScreen({ id: "a", has_mount: true, screen_size: '24"', status: "Completed" }),
          makeScreen({ id: "b", has_mount: true, screen_size: '32"', status: "Completed" }),
          makeScreen({ id: "c", has_mount: true, has_ceiling_mount: true, status: "Offline" }),
          makeScreen({ id: "d", has_mount: true, status: "Upcoming" }), // not installed
          makeScreen({ id: "e", status: "Completed" }), // no mount
        ],
      }),
    );
    expect(computedMountsUsedByPiece(rows)).toEqual({ wall_24: 1, wall: 1, ceiling: 1 });
    expect(computedMountsUsed(rows)).toBe(3);
  });
});
