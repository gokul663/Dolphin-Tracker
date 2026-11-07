import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ProjectKpis } from "@/features/projects/ProjectKpis";
import { makeKpi } from "@/test/fixtures";

const card = (group: HTMLElement, name: string) => {
  const element = within(group).getByLabelText(name);
  return { text: element.textContent, note: element.getAttribute("title") };
};

describe("ProjectKpis", () => {
  it("a compact stores strip: total, upcoming, completed, offline and partly visited", () => {
    render(<ProjectKpis kpi={makeKpi()} />);
    const stores = screen.getByRole("group", { name: "Store KPIs" });
    expect(card(stores, "Stores")).toEqual({ text: "10Total", note: "5 pending" }); // number over label
    expect(card(stores, "Upcoming stores")).toEqual({ text: "5Upcoming", note: "50%" });
    expect(card(stores, "Completed stores")).toEqual({ text: "4Completed", note: "40%" });
    expect(card(stores, "Offline stores")).toEqual({ text: "1Offline", note: "10%" });
    expect(card(stores, "Partly visited stores")).toEqual({ text: "1Partly visited", note: "10%" });
    expect(within(stores).queryByLabelText("Visited stores")).toBeNull();
  });

  it("a compact screens strip: the four main statuses plus any other in use, and recorded vs committed", () => {
    render(<ProjectKpis kpi={makeKpi()} />);
    const screens = screen.getByRole("group", { name: "Screen KPIs" });
    expect(card(screens, "Screens")).toEqual({ text: "12Total", note: "Dolphin 10 of 11 committed · TVs 2 of 3" });
    expect(card(screens, "Upcoming screens").text).toBe("6Upcoming");
    expect(card(screens, "Completed screens").note).toBe("41.7%");
    expect(card(screens, "Archived screens").text).toBe("0Archived"); // always shown
    expect(within(screens).queryByLabelText("Cancelled screens")).toBeNull(); // empty and not a main status
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
