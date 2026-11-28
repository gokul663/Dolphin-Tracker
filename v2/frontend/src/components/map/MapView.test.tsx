import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { circleBounds, MapView } from "@/components/map/MapView";
import { bucketShade, BUCKET_META } from "@/lib/status";
import { mockApi, renderWithProviders } from "@/test/render";
import type { Pin } from "@/lib/api/types";

const pins: Pin[] = [
  { uid: "a", lat: 33.7, lng: -84.4, status: "Completed", store_name: "A", installer: "Ann", day: 1, route_plan_id: "", visit_state: "none", screen_statuses: [] },
  { uid: "b", lat: 33.7, lng: -84.4, status: "Upcoming", store_name: "B", installer: "Ann", day: 1, route_plan_id: "", visit_state: "none", screen_statuses: [] },
  { uid: "c", lat: 33.9, lng: -84.1, status: "Archived", store_name: "C", installer: "Bo", day: 2, route_plan_id: "", visit_state: "none", screen_statuses: [] },
];

describe("MapView", () => {
  it("explains a missing browser key but keeps the legend and counts (stores at one address share a pin)", async () => {
    mockApi({ "GET /api/config/maps": () => ({ google_maps_browser_key: "" }) });
    renderWithProviders(<MapView pins={pins} />);
    expect(await screen.findByText(/no Google Maps browser key is configured/)).toBeTruthy();
    expect(screen.getByText("2 pins · 3 stores")).toBeTruthy();
  });

  it("the legend only explains the colours: every status group has its tag, in one order, no toggles", async () => {
    mockApi({ "GET /api/config/maps": () => ({ google_maps_browser_key: "" }) });
    renderWithProviders(<MapView pins={pins} />);
    await screen.findByText(/no Google Maps browser key/);
    const legend = screen.getByRole("list", { name: "Status colours" });
    expect(within(legend).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Upcoming 1", "Online 1", "Offline 0", "Archived 1", "Cancelled 0", "In Progress 0", // stores: In Progress
    ]);
    expect(within(screen.getByRole("group", { name: "Map legend" })).queryAllByRole("button")).toEqual([]);
    // Each status has its own light → dark bubble scale right under its name.
    for (const item of within(legend).getAllByRole("listitem")) {
      const bucket = item.textContent!.replace(/ \d+$/, "");
      expect(within(item).getByLabelText(`${bucket} clusters, light to dark`)).toBeTruthy();
    }
  });

  it("fits the Nearby circle: a mile is wider in longitude away from the equator", () => {
    const box = circleBounds({ lat: 60, lng: -100, radiusMiles: 69.05 });
    expect(box.north).toBeCloseTo(61);
    expect(box.south).toBeCloseTo(59);
    expect(box.east).toBeCloseTo(-98); // cos 60° = 0.5: two degrees of longitude
    expect(box.west).toBeCloseTo(-102);
  });

  it("shades each group's bubbles light → dark by count", () => {
    expect(bucketShade("Offline", 1)).toBe(BUCKET_META.Offline.light);
    expect(bucketShade("Offline", 200)).toBe(BUCKET_META.Offline.dark);
    expect(bucketShade("Completed", 5000)).toBe(BUCKET_META.Completed.dark);
    expect(bucketShade("Completed", 20)).not.toBe(BUCKET_META.Completed.light);
  });
});
