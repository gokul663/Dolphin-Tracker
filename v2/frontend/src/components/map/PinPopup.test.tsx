import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { addressLines, LocationPopup, StorePopup } from "@/components/map/PinPopup";
import type { Pin } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";

const pin = (uid: string, extra: Partial<Pin> = {}): Pin => ({
  uid, lat: 33.7, lng: -84.4, status: "Completed", store_name: `Store ${uid}`, installer: "", day: 1, route_plan_id: "",
  visit_state: "none", screen_statuses: [], display_id: `IBC-${uid}`, addr: "10 Oak St", city: "Atlanta", state: "GA",
  zip: "30303", ...extra,
});

describe("PinPopup", () => {
  it("puts the street on one line and city, state zip on the next, leaving out what is blank", () => {
    expect(addressLines(pin("a"))).toEqual(["10 Oak St", "Atlanta, GA 30303"]);
    expect(addressLines(pin("a", { addr: "", zip: "" }))).toEqual(["Atlanta, GA"]);
    expect(addressLines({})).toEqual([]); // a planner pin carries no address
  });

  it("one store: name, ExtID, address and its status in the status colour", () => {
    render(<StorePopup pin={pin("a", { status: "Offline" })} />);
    const card = screen.getByLabelText("Store Store a");
    expect(within(card).getByText("Store a")).toBeTruthy();
    expect(within(card).getByText("ExtID IBC-a")).toBeTruthy();
    expect(within(card).getByText("10 Oak St")).toBeTruthy();
    expect(within(card).getByText("Atlanta, GA 30303")).toBeTruthy();
    // Dark text with a dot in the status colour (a coloured word alone can be unreadable).
    expect(within(card).getByText(STATUS_META.Offline.label)).toBeTruthy();
    expect(within(card).getByTestId("status-dot").style.background).not.toBe("");
    expect(within(card).queryAllByRole("button")).toEqual([]); // read only without actions
  });

  it("with actions: an Open store icon button and a Nearby action, each for this store", () => {
    const onOpen = vi.fn();
    const onNearby = vi.fn();
    const store = pin("a");
    render(<StorePopup pin={store} onOpen={onOpen} onNearby={onNearby} />);
    const card = screen.getByLabelText("Store Store a");
    expect(within(card).getByText("Store a")).toBeTruthy();
    expect(within(card).getByText("ExtID IBC-a")).toBeTruthy();
    expect(within(card).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim())).toEqual(["Open store", "Nearby"]);
    fireEvent.click(within(card).getByRole("button", { name: "Open store" }));
    expect(onOpen).toHaveBeenCalledWith("a");
    fireEvent.click(within(card).getByRole("button", { name: "Nearby" }));
    expect(onNearby).toHaveBeenCalledWith(store);
  });

  it("several stores at one address: the address once, each store with its ExtID and status", () => {
    render(<LocationPopup pins={[pin("a"), pin("b", { status: "Upcoming" })]} />);
    const list = screen.getByLabelText("2 locations at this address");
    expect(within(list).getAllByText("10 Oak St")).toHaveLength(1);
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      `1. Store a IBC-a · ${STATUS_META.Completed.label}`,
      `2. Store b IBC-b · ${STATUS_META.Upcoming.label}`,
    ]);
    expect(within(list).queryAllByRole("button")).toEqual([]); // nothing to open on the full-page map
  });

  it("with onSelect each entry opens its store", () => {
    const onSelect = vi.fn();
    render(<LocationPopup pins={[pin("a"), pin("b")]} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /Store b/ }));
    expect(onSelect).toHaveBeenCalledWith("b");
  });
});
