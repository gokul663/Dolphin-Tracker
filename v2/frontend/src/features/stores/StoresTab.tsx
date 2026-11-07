import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MapView } from "@/components/map/MapView";
import { OpenFullPage, UnitToggle } from "@/features/stores/StoresViewControls";
import { useProjectContext } from "@/features/projects/ProjectPage";
import { DEFAULT_STORE_PAGE_SIZE, useFilterOptions, usePins, useStoreList, useStoresByState } from "@/features/stores/api";
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

  const needsAttention = useStoresUi((state) => state.needsAttention);
  const selection = useMemo(() => toStoreFilters(ui.facets, ui.search, needsAttention), [ui.facets, ui.search, needsAttention]);
  const filters: StoreFilters = useMemo(() => ({ ...selection, sort: ui.sort, dir: ui.dir }), [selection, ui.sort, ui.dir]);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_STORE_PAGE_SIZE);
  const [pageIndex, setPageIndex] = useState(0);
  // A new filter, sort, page size or map view starts again at page 1.
  useEffect(() => setPageIndex(0), [filters, bounds, pageSize]);
  const page = useMemo(() => ({ offset: pageIndex * pageSize, limit: pageSize, bounds }), [pageIndex, pageSize, bounds]);
  const list = useStoreList(project.id, filters, page);
  const pins = usePins(project.id, selection);
  const options = useFilterOptions(project.id, selection);
  const unit = useStoresUi((state) => state.unit);
  const setUnit = useStoresUi((state) => state.setUnit);
  const byState = useStoresByState(project.id, selection, unit === "screens" ? "screens" : "stores");

  const stops = list.data?.items ?? [];
  const total = list.data?.total ?? 0;

  const open = useCallback((uid: string) => ui.select(uid, true), []); // stable store action

  return (
    <div className="space-y-3">
      <StoresToolbar project={project} filters={filters}>
        <FilterBar options={options.data} facets={ui.facets} onToggle={ui.toggleFacet} />
      </StoresToolbar>
      <div className="grid gap-3 lg:h-[calc(100vh-15rem)] lg:min-h-[520px] lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
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
          ) : total === 0 ? (
            <Card className="flex-1 items-center justify-center font-mono text-sm text-slate-500">
              {bounds ? "No stores in the current map view." : "No stores match these filters."}
            </Card>
          ) : (
            <StoresTable
              project={project}
              stops={stops}
              total={total}
              offset={page.offset}
              pageSize={pageSize}
              fetching={list.isFetching}
              onPage={(index) => setPageIndex(index)}
              onPageSize={setPageSize}
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
        <div className="flex min-h-0 flex-col gap-3 lg:overflow-y-auto">
          <div className="flex shrink-0 items-center justify-between gap-2">
            <UnitToggle value={unit} onChange={setUnit} />
            <OpenFullPage projectId={project.id} view="map" label="Open map in a new tab" />
          </div>
          <MapView
            unit={unit}
            className="h-[50vh] shrink-0 lg:h-auto lg:min-h-[440px] lg:flex-1"
            pins={pins.data ?? []}
            selectedId={ui.selectedId}
            hoveredId={ui.hoveredId}
            onSelect={open}
            onBoundsChange={ui.setBounds}
          />
          <Suspense fallback={<Card className="h-56 animate-pulse bg-slate-50" aria-label="Top states (loading)" />}>
            <TopStatesChart
              data={byState.data ?? []}
              selected={ui.facets.state}
              onToggle={ui.toggleState}
              unit={unit}
              action={<OpenFullPage projectId={project.id} view="states" label="Open chart in a new tab" />}
            />
          </Suspense>
        </div>
      </div>
      <StoreDrawer project={project} stopId={ui.selectedId} open={ui.drawerOpen} onClose={ui.closeDrawer} />
    </div>
  );
}
