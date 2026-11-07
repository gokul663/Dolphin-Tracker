import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { densityColor, MapView } from "@/components/map/MapView";
import { mockApi, renderWithProviders } from "@/test/render";
import type { Pin } from "@/lib/api/types";

const pins: Pin[] = [
  { uid: "a", lat: 33.7, lng: -84.4, status: "Completed", store_name: "A", installer: "Ann", day: 1, route_plan_id: "", visit_state: "none", screen_statuses: [] },
  { uid: "b", lat: 33.7, lng: -84.4, status: "Upcoming", store_name: "B", installer: "Ann", day: 1, route_plan_id: "", visit_state: "none", screen_statuses: [] },
  { uid: "c", lat: 33.9, lng: -84.1, status: "Archived", store_name: "C", installer: "Bo", day: 2, route_plan_id: "", visit_state: "none", screen_statuses: [] },
];

describe("MapView", () => {
  it("explains a missing browser key but keeps the legend and counts", async () => {
    mockApi({ "GET /api/config/maps": () => ({ google_maps_browser_key: "" }) });
    renderWithProviders(<MapView pins={pins} />);
    expect(await screen.findByText(/no Google Maps browser key is configured/)).toBeTruthy();
    expect(screen.getByText("3 records · 2 pins · 2 at 1 shared addresses")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Upcoming 1/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("legend toggles filter the pins like v1", async () => {
    mockApi({ "GET /api/config/maps": () => ({ google_maps_browser_key: "" }) });
    renderWithProviders(<MapView pins={pins} />);
    await userEvent.click(await screen.findByRole("button", { name: /Completed 1/ }));
    expect(screen.getByRole("button", { name: /Completed 1/ }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("2 records · 2 pins")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Upcoming 1/ }));
    await userEvent.click(screen.getByRole("button", { name: /Archived 1/ }));
    // Turning off the last visible status brings every status back.
    expect(screen.getByText("3 records · 2 pins · 2 at 1 shared addresses")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Completed 1/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("lists only statuses that have stores", async () => {
    mockApi({ "GET /api/config/maps": () => ({ google_maps_browser_key: "" }) });
    renderWithProviders(<MapView pins={pins} />);
    await screen.findByRole("button", { name: /Upcoming 1/ });
    expect(screen.queryByRole("button", { name: /Offline/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Cancelled/ })).toBeNull();
    expect(screen.getByLabelText("Clusters")).toBeTruthy();
  });

  it("colours clusters light → dark blue by density", () => {
    expect(densityColor(2)).toBe("#bae6fd");
    expect(densityColor(20)).toBe("#3b82f6");
    expect(densityColor(200)).toBe("#1e3a8a");
    expect(densityColor(5000)).toBe("#1e3a8a");
  });
});
