import { beforeEach, describe, expect, it } from "vitest";
import { useStoresUi } from "@/stores/ui";

describe("useStoresUi", () => {
  beforeEach(() => useStoresUi.setState({ projectId: null }));

  it("toggles sort direction on the active column and resets per project", () => {
    const ui = useStoresUi.getState();
    ui.enterProject("p1");
    ui.setSort("store_name");
    expect(useStoresUi.getState().dir).toBe("desc");
    ui.setSort("day");
    expect(useStoresUi.getState()).toMatchObject({ sort: "day", dir: "asc" });
    ui.toggleStatus("Completed");
    ui.toggleStatus("Archived");
    ui.toggleStatus("Completed");
    expect(useStoresUi.getState().status).toEqual(["Archived"]);
    ui.select("u1", true);
    ui.enterProject("p1"); // same project: keep state
    expect(useStoresUi.getState().selectedId).toBe("u1");
    ui.enterProject("p2");
    expect(useStoresUi.getState()).toMatchObject({ status: [], sort: "store_name", selectedId: null, drawerOpen: false });
  });
});
