import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectKpis } from "@/features/projects/ProjectKpis";
import { makeKpi } from "@/test/fixtures";

const bubble = (name: string) => {
  const element = screen.getByLabelText(name);
  return { text: element.textContent, note: element.getAttribute("title") };
};

describe("ProjectKpis", () => {
  it("committed (sheet), completed (online + offline), then each status group with the stores under each", () => {
    render(<ProjectKpis kpi={makeKpi()} />);
    const order = screen.getAllByLabelText(/screens|TVs/).map((element) => element.getAttribute("aria-label"));
    expect(order).toEqual([
      "Committed screens and TVs", "Completed screens", "Online screens", "Offline screens",
      "Upcoming screens", "Cancelled screens",
    ]);
    expect(bubble("Committed screens and TVs")).toEqual({
      text: "14Committed9 stores", note: "From the sheet: 11 Dolphin screens · 3 store TVs (10 stores in the project)",
    });
    expect(bubble("Completed screens").text).toBe("6Completed5 stores"); // installed
    expect(bubble("Online screens").text).toBe("5Online4 stores"); // the Completed status
    expect(bubble("Upcoming screens").text).toBe("6Upcoming5 stores");
    expect(screen.queryByLabelText("In Progress screens")).toBeNull(); // not shown for now: counted as Upcoming
    expect(bubble("Cancelled screens").note).toContain("Cancelled, Archived");
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
    expect(screen.queryByRole("button", { name: /need attention/ })).toBeNull(); // none: no pill
    rerender(<ProjectKpis kpi={makeKpi({ needs_attention: 3 })} onNeedsAttention={() => (opened += 1)} />);
    screen.getByRole("button", { name: "3 stores need attention" }).click();
    expect(opened).toBe(1);
  });
});
