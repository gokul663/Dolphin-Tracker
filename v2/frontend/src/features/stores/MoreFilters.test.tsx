import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import { StoresFullPage } from "@/features/stores/StoresFullPage";
import { parseRadius } from "@/features/stores/NearbyControl";
import { mockApi, renderWithProviders } from "@/test/render";
import { makeSummary } from "@/test/fixtures";
import { localDay } from "@/features/stores/filters";
import { NO_FACETS, NO_NUMBERS, NO_RANGES, useStoresUi, viewFromParams, viewToParams } from "@/stores/ui";

const CITIES = Array.from({ length: 100 }, (_, index) => ({ value: `City ${String(index).padStart(3, "0")}`, count: 1 }));

const OPTIONS = {
  status: [{ value: "Upcoming", count: 1 }], installer: [{ value: "Ann", count: 1 }], pa: [], state: [{ value: "GA", count: 2 }],
  city: CITIES, dma: [], venue_type: [], dd_code: [], screen_size: [], route: [], visit: [], bucket: [], install_type: [],
  technician: [], mount: [], fulfilled: [], review: [],
  committed_over_installed: [{ value: "Yes", count: 3 }, { value: "No", count: 2 }],
  tag: [{ value: "To Do", count: 0 }, { value: "Done", count: 2 }, { value: "", count: 3 }],
};

function Where() {
  return <output data-testid="where">{useLocation().search}</output>;
}

function renderMap(query = "") {
  const api = mockApi({
    "GET /api/projects/p1": () => makeSummary(),
    "GET /api/projects/p1/stores/pins": () => [],
    "GET /api/projects/p1/stores/filters": () => OPTIONS,
    "GET /api/projects/p1/stores/by-state": () => [],
    "GET /api/config/maps": () => ({ google_maps_browser_key: "" }),
    "GET /api/places/autocomplete": () => ({ suggestions: [] }),
    "GET /api/places/validate": () => ({ ok: true, lat: 33.75, lng: -84.39, formatted: "1 Main St, Atlanta, GA, USA" }),
  });
  renderWithProviders(
    <>
      <StoresFullPage view="map" />
      <Where />
    </>,
    { path: "/projects/:projectId/:view", route: `/projects/p1/map${query ? `?${query}` : ""}` },
  );
  return api;
}

const lastOverview = (calls: ReturnType<typeof mockApi>["calls"]) =>
  [...calls].reverse().find((call) => call.url.pathname.endsWith("/overview"))!.url.searchParams;

async function openPanel() {
  await userEvent.click(await screen.findByRole("button", { name: /^More Filters/ }));
  return screen.findByRole("dialog", { name: "More Filters" });
}

/** Opens a collapsed section of the panel and returns its body. */
async function openSection(panel: HTMLElement, title: string) {
  const header = within(panel).getByRole("button", { name: new RegExp(`^${title}`) });
  if (header.getAttribute("aria-expanded") !== "true") await userEvent.click(header);
  return within(panel).getByRole("region", { name: new RegExp(`^${title}`) });
}

const daysAgo = (days: number) => {
  const now = new Date();
  return localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days));
};

beforeEach(() => {
  useStoresUi.setState({ projectId: null });
  window.localStorage.clear();
});

describe("More Filters panel", () => {
  it("keeps the most used filters in the bar, Tag and both registration dates included, in Title Case", async () => {
    renderMap();
    const bar = await screen.findByRole("group", { name: "Filters" });
    expect(within(bar).getAllByRole("button").map((button) => button.textContent?.replace("no values", "").trim())).toEqual([
      "Status", "State", "City", "DMA", "DD Code", "Tag", "First Registration Date", "Last Registration Date", "More Filters",
    ]);
  });

  it("groups every filter by kind in collapsible sections, closed until opened, and remembers them", async () => {
    renderMap();
    const panel = await openPanel();
    const headers = within(panel).getAllByRole("heading", { level: 3 }).map((heading) => within(heading).getByRole("button"));
    expect(headers.map((header) => header.textContent)).toEqual(["Location", "Screens", "Mounts", "Dolphin Data", "Work"]);
    expect(headers.map((header) => header.getAttribute("aria-expanded"))).toEqual(["false", "false", "false", "false", "false"]);
    const work = headers[4]!;
    expect(document.getElementById(work.getAttribute("aria-controls")!)!.hidden).toBe(true);
    await userEvent.click(work);
    expect(work.getAttribute("aria-expanded")).toBe("true");
    const body = within(panel).getByRole("region", { name: "Work" });
    expect(body.id).toBe(work.getAttribute("aria-controls"));
    expect(within(body).getAllByRole("group").map((group) => group.getAttribute("aria-labelledby") && document.getElementById(group.getAttribute("aria-labelledby")!)!.textContent)).toEqual([
      "Installer", "Technician", "Install Type", "Route", "Visits", "Tag", "Review Notes",
    ]);
    // The project's tags (even unused), then "No tag".
    expect(within(within(body).getByRole("group", { name: "Tag" })).getAllByRole("checkbox").map((box) => box.getAttribute("aria-label"))).toEqual([
      "To Do", "Done", "No tag",
    ]);
    expect(JSON.parse(window.localStorage.getItem("dt.moreFilters.sections")!)).toMatchObject({ Work: true });
    // Closed and reopened: Work is still open, the rest still closed.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "More Filters" })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More Filters" })); // focus back on the trigger
    const again = await openPanel();
    expect(within(again).getByRole("button", { name: "Work" }).getAttribute("aria-expanded")).toBe("true");
    expect(within(again).getByRole("button", { name: "Location" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("opens a section that has an active filter, and counts its active filters while it is closed", async () => {
    renderMap("tag=Done&committed_over_installed=Yes&screens_committed=gt%3A1");
    const panel = await openPanel();
    const work = within(panel).getByRole("button", { name: "Work" });
    const screensHeader = within(panel).getByRole("button", { name: "Screens" });
    expect(work.getAttribute("aria-expanded")).toBe("true");
    expect(screensHeader.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(screensHeader);
    expect(within(panel).getByRole("button", { name: "Screens 2 active" }).getAttribute("aria-expanded")).toBe("false");
    expect(within(panel).getByRole("button", { name: "Location" }).getAttribute("aria-expanded")).toBe("false");
    expect(within(panel).getByText("3 active · Changes apply as you make them.")).toBeTruthy();
  });

  it("number filters are a comparison and a number: into the request, a chip and the link", async () => {
    const api = renderMap();
    const panel = await openPanel();
    const screensBody = await openSection(panel, "Screens");
    const committed = within(screensBody).getByRole("group", { name: "Screens Committed" });
    const ops = within(committed).getByRole("group", { name: "Screens Committed: comparison" });
    expect(within(ops).getAllByRole("button").map((button) => [button.getAttribute("aria-label"), button.textContent, button.getAttribute("aria-pressed")])).toEqual([
      ["Higher than", ">", "true"], ["Lower than", "<", "false"], ["Equal to", "=", "false"],
    ]);
    // Nothing typed: off.
    expect(lastOverview(api.calls).has("screens_committed")).toBe(false);
    await userEvent.type(within(committed).getByRole("textbox", { name: "Screens Committed: number" }), "2x");
    await waitFor(() => expect(lastOverview(api.calls).get("screens_committed")).toBe("gt:2"));
    expect((within(committed).getByRole("textbox", { name: "Screens Committed: number" }) as HTMLInputElement).value).toBe("2"); // digits only
    await userEvent.click(within(ops).getByRole("button", { name: "Equal to" }));
    await waitFor(() => expect(lastOverview(api.calls).get("screens_committed")).toBe("eq:2"));
    expect(within(ops).getByRole("button", { name: "Equal to" }).getAttribute("aria-pressed")).toBe("true");
    const mounts = await openSection(panel, "Mounts");
    const needed = within(mounts).getByRole("group", { name: "Mounts Needed" });
    await userEvent.click(within(needed).getByRole("button", { name: "Lower than" }));
    await userEvent.type(within(mounts).getByRole("textbox", { name: "Mounts Needed: number" }), "0");
    await waitFor(() => expect(lastOverview(api.calls).get("mounts_needed")).toBe("lt:0"));
    expect(screen.getByRole("button", { name: "More Filters (2 active)" })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toContain("screens_committed=eq%3A2"));
    const chips = screen.getByRole("group", { name: "Active filters" });
    expect(within(chips).getByText("Screens Committed = 2")).toBeTruthy();
    await userEvent.click(within(chips).getByRole("button", { name: "Remove Screens Committed = 2" }));
    await waitFor(() => expect(lastOverview(api.calls).has("screens_committed")).toBe(false));
  });

  it("a registration date: presets stay relative in the link and become today's dates in the request", async () => {
    const api = renderMap();
    const bar = await screen.findByRole("group", { name: "Filters" });
    await userEvent.click(within(bar).getByRole("button", { name: "First Registration Date" }));
    const picker = await screen.findByRole("group", { name: "First Registration Date" });
    expect(within(picker).getAllByRole("button", { pressed: false }).map((button) => button.textContent).slice(0, 4)).toEqual([
      "Today", "Last 2 Days", "Last 7 Days", "Last 30 Days",
    ]);
    await userEvent.click(within(picker).getByRole("button", { name: "Last 7 Days" }));
    expect(within(picker).getByRole("button", { name: "Last 7 Days" }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(lastOverview(api.calls).get("first_registered_from")).toBe(daysAgo(6)));
    expect(lastOverview(api.calls).get("first_registered_to")).toBe(daysAgo(0));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toContain("first_registered=last%3A7d"));
    expect(screen.getByTestId("where").textContent).not.toContain("first_registered_from");
    // Last N weeks.
    await userEvent.clear(within(picker).getByRole("textbox", { name: "First Registration Date: number of days or weeks" }));
    await userEvent.type(within(picker).getByRole("textbox", { name: "First Registration Date: number of days or weeks" }), "2");
    await userEvent.click(within(picker).getByRole("button", { name: "Weeks" }));
    await waitFor(() => expect(lastOverview(api.calls).get("first_registered_from")).toBe(daysAgo(13)));
    await userEvent.click(within(picker).getByRole("button", { name: "Done" }));
    expect(screen.getByRole("button", { name: "First Registration Date: Last 2 Weeks" })).toBeTruthy();
    const chips = screen.getByRole("group", { name: "Active filters" });
    expect(within(chips).getByText("First Registration Date: Last 2 Weeks")).toBeTruthy();
  });

  it("a custom range needs its start on or before its end; either end may stay empty", async () => {
    const api = renderMap();
    await userEvent.click(within(await screen.findByRole("group", { name: "Filters" })).getByRole("button", { name: "Last Registration Date" }));
    const picker = await screen.findByRole("group", { name: "Last Registration Date" });
    fireEvent.change(within(picker).getByLabelText("Last Registration Date start"), { target: { value: "2026-03-31" } });
    await waitFor(() => expect(lastOverview(api.calls).get("last_registered_from")).toBe("2026-03-31"));
    expect(lastOverview(api.calls).has("last_registered_to")).toBe(false);
    fireEvent.change(within(picker).getByLabelText("Last Registration Date end"), { target: { value: "2026-01-01" } });
    expect(within(picker).getByRole("alert").textContent).toContain("start date is after the end date");
    fireEvent.change(within(picker).getByLabelText("Last Registration Date start"), { target: { value: "2026-01-01" } });
    fireEvent.change(within(picker).getByLabelText("Last Registration Date end"), { target: { value: "2026-03-31" } });
    await waitFor(() => expect(lastOverview(api.calls).get("last_registered_to")).toBe("2026-03-31"));
    expect(lastOverview(api.calls).get("last_registered_from")).toBe("2026-01-01");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toContain("last_registered_from=2026-01-01&last_registered_to=2026-03-31"));
    await userEvent.click(within(picker).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(lastOverview(api.calls).has("last_registered_from")).toBe(false));
    expect(screen.getByRole("button", { name: "Last Registration Date" })).toBeTruthy();
  });

  it("applies a facet at once, counts it on the button, and shows removable chips", async () => {
    const api = renderMap();
    const panel = await openPanel();
    const screensBody = await openSection(panel, "Screens");
    await userEvent.click(within(within(screensBody).getByRole("group", { name: "Committed > Installed" })).getByRole("checkbox", { name: "Yes" }));
    await waitFor(() => expect(lastOverview(api.calls).getAll("committed_over_installed")).toEqual(["Yes"]));
    expect(screen.getByRole("button", { name: "More Filters (1 active)" })).toBeTruthy();
    // Filters that are also in the bar do not count on the button.
    const work = await openSection(panel, "Work");
    await userEvent.click(within(within(work).getByRole("group", { name: "Tag" })).getByRole("checkbox", { name: "Done" }));
    await waitFor(() => expect(lastOverview(api.calls).getAll("tag")).toEqual(["Done"]));
    expect(screen.getByRole("button", { name: "More Filters (1 active)" })).toBeTruthy();
    await userEvent.click(within(panel).getByRole("button", { name: "Close filters" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "More Filters" })).toBeNull());
    const chips = screen.getByRole("group", { name: "Active filters" });
    await userEvent.click(within(chips).getByRole("button", { name: "Remove Tag: Done" }));
    await waitFor(() => expect(lastOverview(api.calls).getAll("tag")).toEqual([]));
    expect(within(chips).getByRole("button", { name: "Remove Committed > Installed: Yes" })).toBeTruthy();
  });

  it("Clear All empties the panel's filters", async () => {
    const api = renderMap("tag=Done&state=GA&last_registered_to=2026-02-01&mounts_installed=eq%3A1");
    const panel = await openPanel();
    expect(screen.getByRole("button", { name: "More Filters (1 active)" })).toBeTruthy();
    await userEvent.click(within(panel).getByRole("button", { name: "Clear All" }));
    await waitFor(() => expect(lastOverview(api.calls).has("last_registered_to")).toBe(false));
    expect(lastOverview(api.calls).getAll("tag")).toEqual([]);
    expect(lastOverview(api.calls).getAll("state")).toEqual([]);
    expect(lastOverview(api.calls).has("mounts_installed")).toBe(false);
  });

  it("a long list draws only its first values and a search finds the rest", async () => {
    renderMap();
    const panel = await openPanel();
    const location = await openSection(panel, "Location");
    const city = within(location).getByRole("group", { name: "City" });
    expect(within(city).getAllByRole("checkbox")).toHaveLength(40);
    expect(within(city).getByText("60 more: search to narrow the list")).toBeTruthy();
    await userEvent.type(within(city).getByRole("textbox", { name: "Search City" }), "099");
    expect(within(city).getAllByRole("checkbox").map((box) => box.getAttribute("aria-label"))).toEqual(["City 099"]);
  });
});

describe("the view in the address bar", () => {
  it("carries the day ranges, number comparisons and Nearby both ways, and leaves them out when unset", () => {
    const view = {
      search: "", facets: { ...NO_FACETS, tag: ["Done", ""] }, unit: "locations" as const,
      ranges: { ...NO_RANGES, first_registered: { from: "2026-01-01", to: "" }, last_registered: { kind: "last" as const, n: 2, unit: "weeks" as const } },
      near: { lat: 33.75, lng: -84.39, radius: 10, address: "1 Main St, Atlanta" },
      numbers: { ...NO_NUMBERS, screens_committed: { op: "gt" as const, value: "2" }, mounts_installed: { op: "eq" as const, value: "0" } },
    };
    const params = viewToParams(view);
    expect(params.toString()).toBe(
      "tag=Done&tag=&screens_committed=gt%3A2&mounts_installed=eq%3A0&first_registered_from=2026-01-01&last_registered=last%3A2w&near_lat=33.75&near_lng=-84.39&radius=10&near=1+Main+St%2C+Atlanta",
    );
    expect(viewFromParams(params)).toEqual(view);
    const plain = { search: "", facets: NO_FACETS, unit: "locations" as const };
    expect(viewFromParams(viewToParams(plain))).toEqual(plain);
    // A half-written or broken link is ignored, not half applied; so are an old link's lists of numbers.
    expect(viewFromParams(new URLSearchParams("near_lat=33&radius=5&first_registered_to=tomorrow&first_registered=last%3A0d"))).toEqual(plain);
    expect(viewFromParams(new URLSearchParams("screens_committed=2&screens_committed=3&mounts_needed=gte%3A1"))).toEqual(plain);
  });

  it("an old link with a list of numbers opens without that filter", async () => {
    const api = renderMap("screens_committed=2&tag=Done");
    await waitFor(() => expect(lastOverview(api.calls).getAll("tag")).toEqual(["Done"]));
    expect(lastOverview(api.calls).has("screens_committed")).toBe(false);
  });
});

describe("Nearby", () => {
  it("finds the address, applies a radius, draws a chip and goes into the link", async () => {
    const api = renderMap();
    await userEvent.click(await screen.findByRole("button", { name: "Nearby" }));
    const form = await screen.findByRole("form", { name: "Nearby stores" });
    expect(within(form).getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(true);
    await userEvent.type(within(form).getByRole("combobox", { name: "Nearby address" }), "1 Main St Atlanta{Enter}");
    expect(await within(form).findByText("Found: 33.75000, -84.39000")).toBeTruthy();
    await userEvent.click(within(form).getByRole("button", { name: "25 mi" }));
    await userEvent.click(within(form).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(lastOverview(api.calls).get("radius_miles")).toBe("25"));
    expect(lastOverview(api.calls).get("near_lat")).toBe("33.75");
    expect(lastOverview(api.calls).get("near_lng")).toBe("-84.39");
    expect(screen.getByRole("button", { name: "Nearby: within 25 mi" })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toContain("radius=25"));
    const chips = screen.getByRole("group", { name: "Active filters" });
    await userEvent.click(within(chips).getByRole("button", { name: "Remove Within 25 mi of 1 Main St, Atlanta, GA, USA" }));
    await waitFor(() => expect(lastOverview(api.calls).has("near_lat")).toBe(false));
  });

  it("takes a typed radius and refuses one that is not a positive number", async () => {
    expect(parseRadius("12.5")).toBe(12.5);
    expect([parseRadius(""), parseRadius("0"), parseRadius("-3"), parseRadius("abc"), parseRadius("5000")]).toEqual([null, null, null, null, null]);
    const api = renderMap("near_lat=33.75&near_lng=-84.39&radius=10&near=Here");
    await userEvent.click(await screen.findByRole("button", { name: "Nearby: within 10 mi" }));
    const form = await screen.findByRole("form", { name: "Nearby stores" });
    const box = within(form).getByRole("spinbutton", { name: "Radius in miles" });
    await userEvent.clear(box);
    expect(within(form).getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(true);
    await userEvent.type(box, "7.5");
    await userEvent.click(within(form).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(lastOverview(api.calls).get("radius_miles")).toBe("7.5"));
    await userEvent.click(screen.getByRole("button", { name: "Nearby: within 7.5 mi" }));
    await userEvent.click(within(await screen.findByRole("form", { name: "Nearby stores" })).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(lastOverview(api.calls).has("radius_miles")).toBe(false));
  });
});

describe("Nearby from a store on the map", () => {
  const store = { uid: "s1", name: "Alpha Bar", address: "10 Oak St, Atlanta, GA 30303", lat: 33.7, lng: -84.4 };

  it("fills the centre with the last clicked store, marks the chosen radius, and waits for Apply", async () => {
    const api = renderMap();
    await screen.findByRole("button", { name: "Nearby" });
    act(() => useStoresUi.getState().pickStore(store));
    await userEvent.click(screen.getByRole("button", { name: "Nearby" }));
    const form = await screen.findByRole("form", { name: "Nearby stores" });
    const address = within(form).getByRole("combobox", { name: "Nearby address" }) as HTMLInputElement;
    expect(address.value).toBe("Alpha Bar · 10 Oak St, Atlanta, GA 30303");
    expect(within(form).getByText("From the store you clicked on the map.")).toBeTruthy();
    const radius = within(form).getByRole("group", { name: "Within (Miles)" });
    expect(within(radius).getAllByRole("button").map((button) => [button.textContent, button.getAttribute("aria-pressed")])).toEqual([
      ["5 mi", "false"], ["10 mi", "true"], ["25 mi", "false"], ["50 mi", "false"],
    ]);
    await userEvent.click(within(radius).getByRole("button", { name: "5 mi" }));
    expect(within(radius).getByRole("button", { name: "5 mi" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(radius).getByRole("button", { name: "10 mi" }).getAttribute("aria-pressed")).toBe("false");
    expect(lastOverview(api.calls).has("near_lat")).toBe(false); // not applied yet
    // Another pin clicked while the form is open: it follows.
    act(() => useStoresUi.getState().pickStore({ ...store, uid: "s2", name: "Bravo", lat: 34, lng: -84 }));
    await waitFor(() => expect(address.value).toBe("Bravo · 10 Oak St, Atlanta, GA 30303"));
    await userEvent.click(within(form).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(lastOverview(api.calls).get("near_lat")).toBe("34"));
    expect(lastOverview(api.calls).get("radius_miles")).toBe("5");
  });

  it("the pop-up's Nearby action opens the form pre-filled; a later open keeps what was applied", async () => {
    renderMap();
    await screen.findByRole("button", { name: "Nearby" });
    act(() => {
      useStoresUi.getState().pickStore(store);
      useStoresUi.getState().setNearbyOpen(true);
    });
    const form = await screen.findByRole("form", { name: "Nearby stores" });
    expect((within(form).getByRole("combobox", { name: "Nearby address" }) as HTMLInputElement).value).toBe("Alpha Bar · 10 Oak St, Atlanta, GA 30303");
    await userEvent.click(within(form).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Nearby stores" })).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Nearby: within 10 mi" }));
    const again = await screen.findByRole("form", { name: "Nearby stores" });
    expect((within(again).getByRole("combobox", { name: "Nearby address" }) as HTMLInputElement).value).toBe("Alpha Bar · 10 Oak St, Atlanta, GA 30303");
  });
});
