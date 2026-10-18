import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MapView } from "@/components/map/MapView";
import { mockApi, renderWithProviders } from "@/test/render";
import type { Pin } from "@/lib/api/types";

const pins: Pin[] = [
  { uid: "a", lat: 33.7, lng: -84.4, status: "Completed", store_name: "A", installer: "Ann", day: 1 },
  { uid: "b", lat: 33.7, lng: -84.4, status: "Upcoming", store_name: "B", installer: "Ann", day: 1 },
  { uid: "c", lat: 33.9, lng: -84.1, status: "Archived", store_name: "C", installer: "Bo", day: 2 },
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
    expect(screen.getByText("0 records · 0 pins")).toBeTruthy(); // only the empty statuses are still on
    for (const name of [/Invitation Email Sent 0/, /Shipped 0/, /Delivered 0/, /Offline 0/]) {
      await userEvent.click(screen.getByRole("button", { name }));
    }
    await userEvent.click(screen.getByRole("button", { name: /Cancelled 0/ }));
    // Turning off the last visible status brings every status back.
    expect(screen.getByText("3 records · 2 pins · 2 at 1 shared addresses")).toBeTruthy();
  });
});
