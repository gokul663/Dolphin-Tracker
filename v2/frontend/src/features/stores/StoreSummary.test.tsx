import { describe, expect, it } from "vitest";
import { useState } from "react";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toRows } from "@/features/stores/ScreensEditor";
import { StoreSummary, type SummaryDraft } from "@/features/stores/StoreSummary";
import { makeScreen, makeStop } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render";

const NO_COUNTS = { committed_dolphin_screens: "", committed_store_tvs: "", wall_mounts_needed: "", ceiling_mounts_needed: "", tv_mounts_needed: "" };

function Harness({ initial }: { initial: SummaryDraft }) {
  const [draft, setDraft] = useState(initial);
  return (
    <StoreSummary
      draft={draft}
      technicians={["Sai"]}
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
  it("committed and installed show screens and TVs apart; mount counts add up as typed", async () => {
    renderWithProviders(
      <Harness initial={draftOf([makeScreen({ id: "a", status: "Completed" }), makeScreen({ id: "b", status: "Completed", is_dolphin_screen: false })], { committed_dolphin_screens: "2", committed_store_tvs: "1" })} />,
    );
    expect(screen.getByLabelText("Committed total").textContent).toBe("3");
    expect(screen.getByLabelText("Installed screens").textContent).toBe("1");
    expect(screen.getByLabelText("Installed TVs").textContent).toBe("1");
    expect(screen.getByText("2 of 3 committed")).toBeTruthy();
    const mounts = screen.getByRole("region", { name: "Mounts needed" });
    await userEvent.type(within(mounts).getByLabelText("Wall"), "2");
    await userEvent.type(within(mounts).getByLabelText("TV"), "1");
    expect(within(mounts).getByLabelText("Mounts total").textContent).toBe("3");
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
});
