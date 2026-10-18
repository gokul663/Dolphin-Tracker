import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ProjectKpis } from "@/features/projects/ProjectKpis";
import { makeKpi } from "@/test/fixtures";

describe("ProjectKpis", () => {
  it("shows stores by derived status, pending, screens and committed vs actual", () => {
    render(<ProjectKpis kpi={makeKpi()} />);
    const group = screen.getByRole("group", { name: "Project KPIs" });
    expect(within(group).getByText(/10 stores/).textContent).toBe("10 stores · 5 pending");
    expect(within(group).getByText("Upcoming 5")).toBeTruthy();
    expect(within(group).getByText("Completed 4")).toBeTruthy();
    expect(within(group).queryByText(/Cancelled/)).toBeNull(); // empty statuses are left out
    expect(within(group).getByLabelText("Screens").textContent).toBe("12 screens · Dolphin 10/11 committed · TVs 2/3 committed");
  });
});
