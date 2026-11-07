import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import { StoresFullPage } from "@/features/stores/StoresFullPage";
import { mockApi, renderWithProviders } from "@/test/render";
import { makeSummary } from "@/test/fixtures";
import { useStoresUi, viewFromParams, viewToParams, NO_FACETS } from "@/stores/ui";

const OPTIONS = {
  status: [{ value: "Upcoming", count: 1 }], installer: [], pa: [], state: [{ value: "TX", count: 1 }, { value: "FL", count: 1 }],
  city: [], dma: [], venue_type: [], dd_code: [], screen_size: [],
};

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.search}</output>;
}

function renderPage(view: "map" | "states", query: string) {
  const api = mockApi({
    "GET /api/projects/p1": () => makeSummary(),
    "GET /api/projects/p1/stores/pins": () => [],
    "GET /api/projects/p1/stores/filters": () => OPTIONS,
    "GET /api/projects/p1/stores/by-state": () => [{ state: "TX", count: 3 }],
    "GET /api/config/maps": () => ({ google_maps_browser_key: "" }),
  });
  renderWithProviders(
    <>
      <StoresFullPage view={view} />
      <Where />
    </>,
    { path: "/projects/:projectId/:view", route: `/projects/p1/${view}?${query}` },
  );
  return api;
}

describe("full-page map and chart", () => {
  it("a link carries search, filters and the count unit both ways", () => {
    const view = { search: "mart", facets: { ...NO_FACETS, status: ["Upcoming"], state: ["TX", "FL"] }, unit: "screens" as const };
    const params = viewToParams(view);
    expect(params.toString()).toBe("q=mart&status=Upcoming&state=TX&state=FL&unit=screens");
    expect(viewFromParams(params)).toEqual(view);
  });

  it("opens with the link's filters, applies them, and keeps the address bar in step", async () => {
    useStoresUi.setState({ projectId: null });
    const api = renderPage("map", "state=TX&unit=screens");
    expect(await screen.findByRole("heading", { name: /Atlanta refresh · Map/ })).toBeTruthy();
    const bar = screen.getByRole("group", { name: "Filters" });
    expect(within(bar).getByRole("button", { name: "State: TX" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Screens" }).getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(api.calls.some((c) => c.url.pathname.endsWith("/pins") && c.url.searchParams.get("state") === "TX")).toBe(true));
    expect(screen.queryByText("Only stores in map view")).toBeNull(); // no table here
    await userEvent.click(screen.getByRole("radio", { name: "Locations" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("?state=TX"));
  });

  it("the chart page counts what the switch says", async () => {
    useStoresUi.setState({ projectId: null });
    const api = renderPage("states", "unit=screens");
    expect(await screen.findByRole("region", { name: "Top states by upcoming screens" })).toBeTruthy();
    const byState = api.calls.filter((c) => c.url.pathname.endsWith("/by-state")).at(-1)!.url;
    expect(byState.searchParams.get("unit")).toBe("screens");
  });
});
