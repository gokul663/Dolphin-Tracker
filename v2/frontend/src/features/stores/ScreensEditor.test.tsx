import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { presetOf } from "@/features/stores/ScreensEditor";
import { makeProject, makeScreen, makeStop } from "@/test/fixtures";
import { mockApi, renderWithProviders } from "@/test/render";
import { draftScreens } from "@/test/screens";

describe("screen size presets", () => {
  it("reads the usual ways a size is written", () => {
    expect(presetOf('43"')).toBe(43);
    expect(presetOf("24in")).toBe(24);
    expect(presetOf("55 inch")).toBe(55);
    expect(presetOf("65")).toBe(65);
    expect(presetOf("75\"")).toBeNull(); // not a tile: shown under Other
    expect(presetOf("")).toBeNull();
  });
});

describe("ScreensEditor", () => {
  it("size tiles and Other with free text go into the draft; no save or Needs mount box of its own", async () => {
    mockApi({});
    const stop = makeStop({ screens: [makeScreen({ id: "s1", screen_size: "24in", is_dolphin_screen: false })] }); // a store TV
    const draft = draftScreens(makeProject(), stop);
    renderWithProviders(draft.element);
    const sizes = screen.getByRole("radiogroup", { name: "Size of screen 1" });
    expect(within(sizes).getByRole("radio", { name: "24 inch" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();

    await userEvent.click(within(sizes).getByRole("radio", { name: "55 inch" }));
    expect(within(sizes).getByRole("radio", { name: "55 inch" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("checkbox", { name: /Needs mount/ })).toBeNull();
    expect(draft.latest()[0]).toMatchObject({ screen_size: '55"', has_mount: false });

    await userEvent.click(within(sizes).getByRole("radio", { name: "Other size" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Other size, screen 1" }), '98"');
    expect(draft.latest()[0]?.screen_size).toBe('98"');
  });

  it("a Dolphin TV is 24, 43 or 50 inch (24 by default); a store TV gets the full size tiles", async () => {
    mockApi({});
    const draft = draftScreens(makeProject(), makeStop({ screens: [makeScreen({ id: "s1", is_dolphin_screen: false, screen_size: '55"' })] }));
    renderWithProviders(draft.element);
    expect(within(screen.getByRole("radiogroup", { name: "Size of screen 1" })).getByRole("radio", { name: "Other size" })).toBeTruthy();
    await userEvent.click(screen.getByRole("checkbox", { name: "Dolphin TV, screen 1" }));
    const sizes = screen.getByRole("radiogroup", { name: "Size of screen 1" });
    expect(within(sizes).getAllByRole("radio").map((radio) => radio.getAttribute("aria-label"))).toEqual(["24 inch", "43 inch", "50 inch"]);
    expect(draft.latest()[0]).toMatchObject({ is_dolphin_screen: true, screen_size: '24"' });
    await userEvent.click(within(sizes).getByRole("radio", { name: "50 inch" }));
    expect(draft.latest()[0]?.screen_size).toBe('50"');
  });

});
