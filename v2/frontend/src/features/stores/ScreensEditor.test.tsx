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

  it("size first; then whose screen, which of our types for that size, and the mount (or none)", async () => {
    mockApi({});
    const costs = { stick: 40, screens: [{ size: '24"', type: "Dolphin", cost: 120 }, { size: '24"', type: "Dell", cost: 95 }, { size: '43"', type: "Dolphin", cost: 300 }] };
    const draft = draftScreens(makeProject({ hardware_costs: costs }), makeStop({ screens: [makeScreen({ id: "s1", screen_size: "" })] }));
    renderWithProviders(draft.element);
    // Nothing is asked until a size is picked.
    expect(screen.queryByRole("group", { name: "Owner of screen 1" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Mount of screen 1" })).toBeNull();
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Size of screen 1" })).getByRole("radio", { name: "24 inch" }));
    const pressed = (group: string) => within(screen.getByRole("group", { name: group })).getAllByRole("button").filter((button) => button.getAttribute("aria-pressed") === "true").map((button) => button.textContent);
    expect(pressed("Owner of screen 1")).toEqual(["Dolphin screen"]);
    // 24 inch has two of our types: neither is assumed.
    const types = screen.getByRole("group", { name: "Type of screen 1" });
    expect(within(types).getAllByRole("button").map((button) => button.textContent)).toEqual(["Dolphin", "Dell"]);
    expect(pressed("Type of screen 1")).toEqual([]);
    await userEvent.click(within(types).getByRole("button", { name: "Dell" }));
    expect(draft.latest()[0]).toMatchObject({ screen_size: '24"', is_dolphin_screen: true, screen_type: "Dell" });
    // 43 inch has one type, so it is taken; a size without any asks nothing.
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Size of screen 1" })).getByRole("radio", { name: "43 inch" }));
    expect(draft.latest()[0]).toMatchObject({ screen_size: '43"', screen_type: "Dolphin" });
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Size of screen 1" })).getByRole("radio", { name: "55 inch" }));
    expect(screen.queryByRole("group", { name: "Type of screen 1" })).toBeNull();
    expect(draft.latest()[0]?.screen_type).toBe("");
    // Mount: wall or ceiling, and either can be unpicked again (no mount).
    const mount = screen.getByRole("group", { name: "Mount of screen 1" });
    expect(pressed("Mount of screen 1")).toEqual([]);
    await userEvent.click(within(mount).getByRole("button", { name: "Ceiling mount" }));
    expect(draft.latest()[0]).toMatchObject({ has_mount: true, has_ceiling_mount: true });
    await userEvent.click(within(mount).getByRole("button", { name: "Wall mount" }));
    expect(draft.latest()[0]).toMatchObject({ has_mount: true, has_ceiling_mount: false });
    await userEvent.click(within(mount).getByRole("button", { name: "Wall mount" }));
    expect(draft.latest()[0]).toMatchObject({ has_mount: false, has_ceiling_mount: false });
    // A store TV is none of our types.
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Size of screen 1" })).getByRole("radio", { name: "24 inch" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Type of screen 1" })).getByRole("button", { name: "Dell" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Owner of screen 1" })).getByRole("button", { name: "Store TV" }));
    expect(draft.latest()[0]).toMatchObject({ is_dolphin_screen: false, screen_type: "" });
    expect(screen.queryByRole("group", { name: "Type of screen 1" })).toBeNull();
  });

});
