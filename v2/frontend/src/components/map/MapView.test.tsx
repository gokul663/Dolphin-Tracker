import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { MapView } from "@/components/map/MapView";
import { bucketShade, BUCKET_META } from "@/lib/status";
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
  });

  it("the legend only explains the colours: one entry per status group with stores, no toggles", async () => {
    mockApi({ "GET /api/config/maps": () => ({ google_maps_browser_key: "" }) });
    renderWithProviders(<MapView pins={pins} />);
    await screen.findByText(/no Google Maps browser key/);
    const legend = screen.getByRole("list", { name: "Status colours" });
    expect(within(legend).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Completed 1", "Upcoming 1", "Cancelled 1"]);
    expect(within(screen.getByRole("group", { name: "Map legend" })).queryAllByRole("button")).toEqual([]);
    // Each status has its own light → dark bubble scale right under its name.
    for (const item of within(legend).getAllByRole("listitem")) {
      const bucket = item.textContent!.split(" ")[0]!;
      expect(within(item).getByLabelText(`${bucket} clusters, light to dark`)).toBeTruthy();
    }
  });

  it("shades each group's bubbles light → dark by count", () => {
    expect(bucketShade("Offline", 1)).toBe(BUCKET_META.Offline.light);
    expect(bucketShade("Offline", 200)).toBe(BUCKET_META.Offline.dark);
    expect(bucketShade("Completed", 5000)).toBe(BUCKET_META.Completed.dark);
    expect(bucketShade("Completed", 20)).not.toBe(BUCKET_META.Completed.light);
  });
});
