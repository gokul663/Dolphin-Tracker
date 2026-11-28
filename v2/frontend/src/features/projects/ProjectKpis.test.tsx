import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectKpis } from "@/features/projects/ProjectKpis";
import { makeKpi } from "@/test/fixtures";

const bubble = (name: string) => {
  const element = screen.getByLabelText(name);
  return { text: element.textContent, note: element.getAttribute("title") };
};

describe("ProjectKpis", () => {
  it("totals first (committed, completed, upcoming, needs review, need attention), then the screens by status", () => {
    render(<ProjectKpis kpi={makeKpi()} />);
    const labels = (group: string) => [...screen.getByRole("group", { name: group }).children].map((element) => element.getAttribute("aria-label"));
    expect(labels("Totals")).toEqual([
      "Committed screens and TVs", "Completed screens", "Upcoming screens", "0 screens need review", "0 stores need attention",
    ]);
    expect(labels("Screens by status")).toEqual([
      "Online screens", "Offline screens", "Not Registered screens", "Cancelled screens", "Archived screens", "Partly visited stores",
    ]);
    expect(bubble("Committed screens and TVs")).toEqual({
      text: "14Committed9 stores", note: "From the sheet: 11 Dolphin screens · 3 store TVs",
    });
    expect(bubble("Completed screens").text).toBe("6Completed5 stores"); // installed
    expect(bubble("Online screens").text).toBe("5Online4 stores"); // the Completed status
    expect(bubble("Upcoming screens").text).toBe("6Upcoming5 stores");
    expect(screen.queryByLabelText("In Progress screens")).toBeNull(); // not shown for now: counted as Upcoming
    expect(bubble("Cancelled screens").note).toContain("never registered a screen");
    expect(bubble("Archived screens").note).toContain("ran for a while");
    expect(bubble("Offline screens").note).toMatch(/^8.3% of screens/);
  });

  it("no technician bubbles in the header", () => {
    render(<ProjectKpis kpi={makeKpi({ by_technician: { Murugan: { done: 200, upcoming: 3 } } })} />);
    expect(screen.queryByText(/Murugan/)).toBeNull();
  });

  it("a status bubble toggles the stores filter and shows when it is on", () => {
    const clicked: string[] = [];
    render(<ProjectKpis kpi={makeKpi()} activeBuckets={["Offline"]} onBucket={(bucket) => clicked.push(bucket)} />);
    expect(screen.queryByRole("button", { name: "Completed screens" })).toBeNull(); // a total, not a filter
    screen.getByRole("button", { name: "Online screens" }).click();
    expect(clicked).toEqual(["Completed"]);
    expect(screen.getByRole("button", { name: "Offline screens" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows how many stores need attention, and opens them", async () => {
    let opened = 0;
    const { rerender } = render(<ProjectKpis kpi={makeKpi()} onNeedsAttention={() => (opened += 1)} />);
    expect((screen.getByRole("button", { name: "0 stores need attention" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<ProjectKpis kpi={makeKpi({ needs_attention: 3 })} onNeedsAttention={() => (opened += 1)} />);
    screen.getByRole("button", { name: "3 stores need attention" }).click();
    expect(opened).toBe(1);
  });

  it("needs review adds the Dolphin data's unknown screens and the screens missing at done stores", () => {
    const opened: string[] = [];
    const props = { onDeviceReview: () => opened.push("dolphin"), onMissingScreens: () => opened.push("missing") };
    const { rerender } = render(<ProjectKpis kpi={makeKpi({ review_screens: 4, review_stores: 3 })} reviewCount={35} {...props} />);
    const both = screen.getByRole("button", { name: "39 screens need review" });
    expect(both.textContent).toBe(" 39Needs review35 new · 4 missing");
    both.click(); // the Dolphin data's list, which also points at the missing ones
    rerender(<ProjectKpis kpi={makeKpi({ review_screens: 4, review_stores: 3 })} {...props} />);
    screen.getByRole("button", { name: "4 screens need review" }).click(); // only missing screens: straight to those stores
    expect(opened).toEqual(["dolphin", "missing"]);
  });

  it("needs review counts the screens of another PA at our addresses, and opens the review list for them", () => {
    const opened: string[] = [];
    const props = { onDeviceReview: () => opened.push("dolphin"), onMissingScreens: () => opened.push("missing") };
    render(<ProjectKpis kpi={makeKpi({ review_screens: 4, review_stores: 3 })} otherPaCount={3} {...props} />);
    const tile = screen.getByRole("button", { name: "7 screens need review" });
    expect(tile.textContent).toBe(" 7Needs review4 missing · 3 other PA");
    tile.click();
    expect(opened).toEqual(["dolphin"]);
  });
});
