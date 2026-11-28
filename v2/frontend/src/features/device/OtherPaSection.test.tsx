import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewDialog } from "@/features/device/ReviewDialog";
import { mockApi, renderWithProviders } from "@/test/render";
import { makeProject } from "@/test/fixtures";
import type { DeviceSyncState, OtherPaScreen } from "@/lib/api/types";

const STATE: DeviceSyncState = {
  pa: "IBC", snapshot_date: "2026-11-09", ingested_at: "", synced_at: "2026-11-10T12:00:00+00:00",
  matched_screens: 2, status_changes: 0, review_count: 0, not_reporting: 0, other_pa_count: 2,
};

const ATM: OtherPaScreen = {
  key: "DD_ATM1:s1", venue_id: "DD_ATM1", pa_name: "ATM Co", venue_name: "CMS_ATM1", status: "Online", stop_uid: "s1",
  store_name: "Oak Market", external_id: "EXT-1", address: "10 Oak St, Macon, GA 31201",
};
const BLANK: OtherPaScreen = { ...ATM, key: "DD_ATM2:s1", venue_id: "DD_ATM2", pa_name: "", venue_name: "CMS_ATM2", status: "Offline" };

function renderDialog(onOpenStore?: (uid: string) => void) {
  return renderWithProviders(
    <ReviewDialog project={makeProject({ device_pa: "IBC", device_sync: STATE })} open onClose={() => {}} onOpenStore={onOpenStore} />,
  );
}

describe("Needs review: screens from another PA at our addresses", () => {
  it("lists them apart, with no Add, and marks one or several reviewed", async () => {
    const { calls } = mockApi({
      "GET /api/projects/p1/device-sync/review": () => ({ items: [], next_cursor: null, total: 0, snoozed: 0 }),
      "GET /api/projects/p1/device-sync/other-pa": () => ({ items: [ATM, BLANK], next_cursor: null, total: 2 }),
      "POST /api/projects/p1/device-sync/other-pa/DD_ATM1%3As1/reviewed": () => ATM,
      "POST /api/projects/p1/device-sync/other-pa/DD_ATM2%3As1/reviewed": () => BLANK,
    });
    const opened: string[] = [];
    renderDialog((uid) => opened.push(uid));
    const section = await screen.findByRole("region", { name: /Screens from another PA at our addresses/ });
    expect(section.textContent).toContain("These are not added to the project. If one is wrong, fix it in the CMS.");
    const rows = within(section).getAllByRole("listitem");
    expect(rows[0]!.textContent).toContain("EXT-1");
    expect(rows[0]!.textContent).toContain("10 Oak St, Macon, GA 31201");
    expect(rows[0]!.textContent).toContain("DD_ATM1ATM CoOnline");
    expect(rows[1]!.textContent).toContain("DD_ATM2No PAOffline");
    expect(within(section).queryByRole("button", { name: /^Add/ })).toBeNull();

    await userEvent.click(within(rows[0]!).getByRole("button", { name: "Oak Market" }));
    expect(opened).toEqual(["s1"]);

    await userEvent.click(within(rows[0]!).getByRole("button", { name: "Reviewed, it's fine: DD_ATM1" }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.url.pathname.endsWith("/DD_ATM1%3As1/reviewed"))).toBe(true));

    await userEvent.click(within(section).getByRole("checkbox", { name: "Select all screens from another PA on this page" }));
    await userEvent.click(within(section).getByRole("button", { name: "Reviewed, it's fine for 2" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "POST" && call.url.pathname.endsWith("/reviewed"))).toHaveLength(3));
  });

  it("shows nothing when there is none", async () => {
    const { calls } = mockApi({
      "GET /api/projects/p1/device-sync/review": () => ({ items: [], next_cursor: null, total: 0, snoozed: 0 }),
      "GET /api/projects/p1/device-sync/other-pa": () => ({ items: [], next_cursor: null, total: 0 }),
    });
    renderDialog();
    // Each list has its own tab; the dialog opens on the one with something waiting (here the count says 2).
    expect(screen.getByRole("tab", { name: /Screens from another PA at our addresses/, selected: true })).toBeTruthy();
    expect(await screen.findByText("No screen from another PA at our addresses.")).toBeTruthy();
    expect(calls.some((call) => call.url.pathname.endsWith("/other-pa"))).toBe(true);
    await userEvent.click(screen.getByRole("tab", { name: /New screens of IBC/ }));
    expect(await screen.findByText("Nothing to review.")).toBeTruthy();
    expect(screen.queryByText("No screen from another PA at our addresses.")).toBeNull(); // one list at a time
  });

  it("a viewer sees them but cannot mark them reviewed", async () => {
    mockApi({
      "GET /api/projects/p1/device-sync/review": () => ({ items: [], next_cursor: null, total: 0, snoozed: 0 }),
      "GET /api/projects/p1/device-sync/other-pa": () => ({ items: [ATM], next_cursor: null, total: 1 }),
    });
    renderWithProviders(<ReviewDialog project={makeProject({ device_pa: "IBC", device_sync: STATE })} open onClose={() => {}} />, { role: "viewer" });
    const section = await screen.findByRole("region", { name: /Screens from another PA at our addresses/ });
    expect(within(section).queryByRole("button", { name: /Reviewed/ })).toBeNull();
    expect(within(section).queryByRole("checkbox")).toBeNull();
  });
});
