import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { presetOf, ScreensView, toInputs, toRows } from "@/features/stores/ScreensEditor";
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

  it("size first; then who the screen belongs to, its brand, and for ours the mount (or none)", async () => {
    mockApi({});
    const costs = { stick: 40, screens: [{ size: '24"', type: "Dolphin", cost: 120, is_default: true }, { size: '24"', type: "Dell", cost: 95, is_default: false }, { size: '43"', type: "Dolphin", cost: 300, is_default: true }], mounts: [], hidden: false };
    const draft = draftScreens(makeProject({ hardware_costs: costs }), makeStop({ screens: [makeScreen({ id: "s1", screen_size: "" })] }));
    renderWithProviders(draft.element);
    // Nothing is asked until a size is picked.
    expect(screen.queryByRole("group", { name: "Owner of screen 1" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Mount of screen 1" })).toBeNull();
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Size of screen 1" })).getByRole("radio", { name: "24 inch" }));
    const pressed = (group: string) => within(screen.getByRole("group", { name: group })).getAllByRole("button").filter((button) => button.getAttribute("aria-pressed") === "true").map((button) => button.textContent);
    expect(pressed("Owner of screen 1")).toEqual(["Dolphin"]);
    // 24 inch has two of our types: the one marked default in Settings is taken, the other can be picked.
    const types = screen.getByRole("group", { name: "Brand of screen 1" });
    expect(within(types).getAllByRole("button").map((button) => button.textContent)).toEqual(["Dolphin", "Dell"]);
    expect(pressed("Brand of screen 1")).toEqual(["Dolphin"]);
    await userEvent.click(within(types).getByRole("button", { name: "Dell" }));
    expect(draft.latest()[0]).toMatchObject({ screen_size: '24"', is_dolphin_screen: true, screen_type: "Dell" });
    // 43 inch has no Dell, so its own first type is taken; a size without any asks nothing.
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Size of screen 1" })).getByRole("radio", { name: "43 inch" }));
    expect(draft.latest()[0]).toMatchObject({ screen_size: '43"', screen_type: "Dolphin" });
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Size of screen 1" })).getByRole("radio", { name: "55 inch" }));
    expect(screen.queryByRole("group", { name: "Brand of screen 1" })).toBeNull();
    expect(draft.latest()[0]?.screen_type).toBe("");
    // Mount: wall or ceiling, and either can be unpicked again (no mount).
    const mount = screen.getByRole("group", { name: "Mount of screen 1" });
    expect(pressed("Mount of screen 1")).toEqual([]);
    await userEvent.click(within(mount).getByRole("button", { name: "Ceiling" }));
    expect(draft.latest()[0]).toMatchObject({ has_mount: true, has_ceiling_mount: true });
    await userEvent.click(within(mount).getByRole("button", { name: "Wall" }));
    expect(draft.latest()[0]).toMatchObject({ has_mount: true, has_ceiling_mount: false });
    await userEvent.click(within(mount).getByRole("button", { name: "Wall" }));
    expect(draft.latest()[0]).toMatchObject({ has_mount: false, has_ceiling_mount: false });
    // A store's own TV: no mount of ours, and its brand from the usual makes (or Other, typed).
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Size of screen 1" })).getByRole("radio", { name: "24 inch" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Brand of screen 1" })).getByRole("button", { name: "Dell" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Mount of screen 1" })).getByRole("button", { name: "Wall" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Owner of screen 1" })).getByRole("button", { name: "Store" }));
    expect(draft.latest()[0]).toMatchObject({ is_dolphin_screen: false, screen_type: "", has_mount: false });
    expect(screen.queryByRole("group", { name: "Brand of screen 1" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Mount of screen 1" })).toBeNull();
    await userEvent.click(screen.getByRole("combobox", { name: "Brand of screen 1" }));
    await userEvent.click(await screen.findByRole("option", { name: "LG" }));
    expect(draft.latest()[0]).toMatchObject({ is_dolphin_screen: false, screen_type: "LG" });
    await userEvent.click(screen.getByRole("combobox", { name: "Brand of screen 1" }));
    await userEvent.click(await screen.findByRole("option", { name: "Other" }));
    await userEvent.type(screen.getByLabelText("Other brand, screen 1"), "Onida");
    expect(draft.latest()[0]?.screen_type).toBe("Onida");
  });

});

describe("ScreensView pictures", () => {
  it("shows how many pictures each screen has, the thumbnails a click away, and keeps them in an edit", async () => {
    mockApi({ "GET /api/projects/p1/stores/u1/visits": () => ({ items: [], next_cursor: null }) });
    const stop = makeStop({ screens: [makeScreen({ id: "s1", pictures: ["https://example.com/a.jpg", "https://example.com/b.jpg"] }), makeScreen({ id: "s2" })] });
    renderWithProviders(<ScreensView project={makeProject()} stop={stop} rows={toRows(stop)} />);
    await userEvent.click(screen.getByRole("button", { name: "Pictures of screen 1: 2" }));
    expect(within(await screen.findByRole("list", { name: "Pictures of screen 1" })).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Pictures of screen 2/ })).toBeNull();
    // Sent back with the rows, so a save of anything else keeps them.
    expect(toInputs(toRows(stop))[0]?.pictures).toEqual(["https://example.com/a.jpg", "https://example.com/b.jpg"]);
  });
});
