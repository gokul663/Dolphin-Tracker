import { beforeEach, describe, expect, it } from "vitest";
import { NO_FACETS, useStoresUi } from "@/stores/ui";

describe("useStoresUi", () => {
  beforeEach(() => useStoresUi.setState({ projectId: null, facets: NO_FACETS }));

  it("toggles sort direction on the active column and resets per project", () => {
    const ui = useStoresUi.getState();
    ui.enterProject("p1");
    ui.setSort("store_name");
    expect(useStoresUi.getState().dir).toBe("desc");
    ui.setSort("day");
    expect(useStoresUi.getState()).toMatchObject({ sort: "day", dir: "asc" });
    ui.toggleFacet("status", "Completed");
    ui.toggleFacet("status", "Archived");
    ui.toggleFacet("status", "Completed");
    expect(useStoresUi.getState().facets.status).toEqual(["Archived"]);
    ui.select("u1", true);
    ui.enterProject("p1"); // same project: keep state
    expect(useStoresUi.getState().selectedId).toBe("u1");
    ui.enterProject("p2");
    expect(useStoresUi.getState()).toMatchObject({ sort: "store_name", selectedId: null, drawerOpen: false });
    expect(useStoresUi.getState().facets.status).toEqual([]);
  });

  it("the top-states chart selects one state, a second click clears it, other filters stay", () => {
    const ui = useStoresUi.getState();
    ui.toggleFacet("dma", "ATL");
    ui.toggleFacet("state", "GA");
    ui.toggleFacet("state", "TN"); // picked two in the filter bar
    ui.toggleState("TN"); // a bar click narrows to TN alone
    expect(useStoresUi.getState().facets).toMatchObject({ state: ["TN"], dma: ["ATL"] });
    ui.toggleState("GA"); // another bar switches
    expect(useStoresUi.getState().facets.state).toEqual(["GA"]);
    ui.toggleState("GA"); // the highlighted bar again clears State
    expect(useStoresUi.getState().facets).toMatchObject({ state: [], dma: ["ATL"] });
  });
});
