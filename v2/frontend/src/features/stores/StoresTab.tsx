import { lazy, Suspense, useCallback, useEffect, useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MapView } from "@/components/map/MapView";
import { inBounds } from "@/components/map/pins";
import { useProjectContext } from "@/features/projects/ProjectPage";
import { useFilterOptions, usePins, useStoreList, useStoresByState } from "@/features/stores/api";
import { FilterBar } from "@/features/stores/FilterBar";
import { toStoreFilters } from "@/features/stores/filters";
import { StoreDrawer } from "@/features/stores/StoreDrawer";
import { StoresTable } from "@/features/stores/StoresTable";
import { StoresToolbar } from "@/features/stores/StoresToolbar";
import type { StoreFilters } from "@/lib/api/resources";
import { useShallow } from "zustand/react/shallow";
import { useStoresUi } from "@/stores/ui";

// Recharts is heavy; the chart loads after the table and map (as on the dashboard, §9 #9).
const TopStatesChart = lazy(() => import("@/features/stores/TopStatesChart"));

/** Table left, synced map and the top-states chart right (stacked on narrow screens), all driven by the same
 *  filters. */
export function StoresTab() {
  const project = useProjectContext();
  const ui = useStoresUi(
    useShallow((state) => ({
      facets: state.facets,
      search: state.search,
      sort: state.sort,
      dir: state.dir,
      onlyInView: state.onlyInView,
      selectedId: state.selectedId,
      hoveredId: state.hoveredId,
      drawerOpen: state.drawerOpen,
      enterProject: state.enterProject,
      toggleFacet: state.toggleFacet,
      toggleState: state.toggleState,
      setSort: state.setSort,
      setBounds: state.setBounds,
      hover: state.hover,
      select: state.select,
      closeDrawer: state.closeDrawer,
    })),
  );
  // Map bounds matter only for "only stores in view"; otherwise panning never re-renders the tab or the table.
  const bounds = useStoresUi((state) => (state.onlyInView ? state.bounds : null));
  useEffect(() => ui.enterProject(project.id), [project.id]); // the store action is stable

  const selection = useMemo(() => toStoreFilters(ui.facets, ui.search), [ui.facets, ui.search]);
  const filters: StoreFilters = useMemo(() => ({ ...selection, sort: ui.sort, dir: ui.dir }), [selection, ui.sort, ui.dir]);
  const list = useStoreList(project.id, filters);
  const pins = usePins(project.id, selection);
  const options = useFilterOptions(project.id, selection);
  const byState = useStoresByState(project.id, selection);

  // "Only stores in view" needs the whole filtered set to intersect with the map bounds.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    if (ui.onlyInView && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [ui.onlyInView, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const loaded = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const stops = useMemo(() => {
    if (!bounds) return loaded;
    return loaded.filter((stop) => stop.lat !== null && stop.lng !== null && inBounds({ lat: stop.lat, lng: stop.lng }, bounds));
  }, [loaded, bounds]);

  const open = useCallback((uid: string) => ui.select(uid, true), []); // stable store action

  return (
    <div className="space-y-3">
      <StoresToolbar project={project} filters={filters} />
      <FilterBar options={options.data} facets={ui.facets} onToggle={ui.toggleFacet} />
      <div className="grid gap-3 lg:h-[calc(100vh-15rem)] lg:min-h-[520px] lg:grid-cols-[minmax(0,1fr)_minmax(320px,40%)]">
        <div className="flex h-[60vh] min-h-0 flex-col lg:h-auto">
          {list.isPending ? (
            <Card className="flex-1 items-center justify-center font-mono text-sm text-slate-500">Loading stores…</Card>
          ) : list.isError ? (
            <Card className="flex-1 items-center justify-center gap-3 text-sm text-rose-700">
              Could not load stores: {list.error.message}
              <Button variant="outline" size="sm" onClick={() => list.refetch()}>
                Retry
              </Button>
            </Card>
          ) : stops.length === 0 ? (
            <Card className="flex-1 items-center justify-center font-mono text-sm text-slate-500">
              {loaded.length ? "No stores in the current map view." : "No stores match these filters."}
            </Card>
          ) : (
            <StoresTable
              project={project}
              stops={stops}
              total={null}
              hasNextPage={Boolean(hasNextPage) && !ui.onlyInView}
              fetchingNext={isFetchingNextPage}
              fetchNextPage={() => void fetchNextPage()}
              sort={ui.sort}
              dir={ui.dir}
              onSort={ui.setSort}
              selectedId={ui.selectedId}
              hoveredId={ui.hoveredId}
              onHover={ui.hover}
              onOpen={open}
            />
          )}
        </div>
        <div className="flex min-h-0 flex-col gap-3">
          <MapView
            className="h-[50vh] lg:h-auto lg:min-h-0 lg:flex-1"
            pins={pins.data ?? []}
            selectedId={ui.selectedId}
            hoveredId={ui.hoveredId}
            onSelect={open}
            onBoundsChange={ui.setBounds}
          />
          <Suspense fallback={<Card className="h-56 animate-pulse bg-slate-50" aria-label="Top states (loading)" />}>
            <TopStatesChart data={byState.data ?? []} selected={ui.facets.state} onToggle={ui.toggleState} />
          </Suspense>
        </div>
      </div>
      <StoreDrawer project={project} stopId={ui.selectedId} open={ui.drawerOpen} onClose={ui.closeDrawer} />
    </div>
  );
}
