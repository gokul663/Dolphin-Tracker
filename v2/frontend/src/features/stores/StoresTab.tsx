import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MapView } from "@/components/map/MapView";
import { OpenFullPage } from "@/features/stores/StoresViewControls";
import { useDeviceReview } from "@/features/device/api";
import { DEVICE_TONE, REPORT_STATUS_TONE } from "@/features/device/DeviceBits";
import { useOpenDeviceReview, useProjectContext } from "@/features/projects/ProjectPage";
import { DEFAULT_STORE_PAGE_SIZE, useScreenList, useStoreList, useStoresOverview } from "@/features/stores/api";
import { HardwareCostChart } from "@/features/stores/HardwareCostChart";
import { BucketChips } from "@/features/stores/BucketChips";
import { FilterBar } from "@/features/stores/FilterBar";
import { toStoreFilters } from "@/features/stores/filters";
import { StoreDrawer } from "@/features/stores/StoreDrawer";
import { ScreensTable } from "@/features/stores/ScreensTable";
import { StoresTable } from "@/features/stores/StoresTable";
import { StoresListActions, StoresToolbar } from "@/features/stores/StoresToolbar";
import type { StoreFilters } from "@/lib/api/resources";
import { useShallow } from "zustand/react/shallow";
import { useStoresUi } from "@/stores/ui";
import { cn } from "@/lib/utils";

// Recharts is heavy; the chart loads after the table and map (as on the dashboard, §9 #9).
const TopStatesChart = lazy(() => import("@/features/stores/TopStatesChart"));

/** Filters on top, then the map (three quarters) beside the top-states chart, then the table full width; all
 *  driven by the same filters. */
/** How many matching Needs review records the search shows in line; the rest are in the dialog. */
const WAITING_SHOWN = 5;

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
  // Stores or Screens (the switch in the page header): what the map and chart count, and what a table row is.
  const unit = useStoresUi((state) => state.unit);
  const byScreen = unit === "screens";
  const storeList = useStoreList(project.id, filters, page, !byScreen);
  const screenList = useScreenList(project.id, filters, page, byScreen);
  const list = byScreen ? screenList : storeList;
  const noun = byScreen ? "screens" : "stores";
  // The pins, the filter options, the top states and the hardware counts come in one request (`useStoresOverview`).
  const overview = useStoresOverview(project.id, selection, unit === "screens" ? "screens" : "stores");
  const pins = { data: overview.data?.pins };
  const options = { data: overview.data?.filters };
  const byState = { data: overview.data?.by_state };
  const hardware = { data: overview.data?.hardware };

  // The search also looks in "Needs review": a screen the Dolphin data reports that is in no store yet is not in
  // the list below, so a search for its ExtID or address would otherwise find nothing and say nothing.
  const searched = ui.search.trim();
  const waiting = useDeviceReview(
    project.id, { limit: WAITING_SHOWN, cursor: null }, true, Boolean(searched) && Boolean(project.device_sync), searched,
  );
  const waitingCount = searched ? (waiting.data?.total ?? 0) : 0;
  const openReview = useOpenDeviceReview();

  const total = list.data?.total ?? 0;
  const paging = { total, offset: page.offset, pageSize, fetching: list.isFetching, onPage: setPageIndex, onPageSize: setPageSize };
  const rowState = { sort: ui.sort, dir: ui.dir, onSort: ui.setSort, selectedId: ui.selectedId, hoveredId: ui.hoveredId, onHover: ui.hover };

  const open = useCallback((uid: string) => ui.select(uid, true), []); // stable store action

  return (
    <div className="space-y-3">
      {/* One filter card: the status groups first, then search and the other filters. Table, map and chart all
          follow it; the map legend below only hides pins. */}
      <Card className="gap-2.5 p-3">
        {/* Two lines: the status chips with "only in map view" and CSV at the right, then search and filters. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <BucketChips options={options.data?.bucket} selected={ui.facets.bucket} onToggle={(bucket) => ui.toggleFacet("bucket", bucket)} />
          <StoresListActions project={project} filters={filters} onAdded={open} />
        </div>
        <StoresToolbar project={project} filters={filters} onPick={open}>
          <FilterBar options={options.data} facets={ui.facets} onToggle={ui.toggleFacet} />
        </StoresToolbar>
        {waitingCount > 0 && (
          <section aria-label="Matches in Needs review" className={cn("space-y-1.5 rounded-lg border px-3 py-2 text-sm text-cyan-900", DEVICE_TONE.panel)}>
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1">
                <span className="font-semibold">
                  {waitingCount} {waitingCount === 1 ? "screen" : "screens"} in Needs review
                </span>{" "}
                {waitingCount === 1 ? "matches" : "match"} "{searched}": in the Dolphin data, not in a store of this project yet.
              </p>
              <Button size="sm" variant="outline" onClick={() => openReview(searched)}>
                Show in Needs review
              </Button>
            </div>
            {/* The records themselves, each with what the Dolphin data says about it. */}
            <ul className="divide-y divide-cyan-100">
              {(waiting.data?.items ?? []).map((item) => (
                <li key={item.key} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1">
                  <span className="rounded border border-cyan-300 bg-white px-1.5 py-0.5 text-[11px] font-medium text-cyan-800">Needs review</span>
                  <span className={cn("rounded border px-1 text-[11px]", REPORT_STATUS_TONE[item.status.toLowerCase()] ?? "border-slate-200 bg-white text-slate-600")}>
                    {item.status || "Unknown"}
                  </span>
                  <span className="font-mono text-xs">{item.external_id || "no ExtID"}</span>
                  <span className="font-medium">{item.store_name || item.venue_name || "No name in the report"}</span>
                  <span className="font-mono text-xs text-slate-500">{item.venue_id}</span>
                  <span className="min-w-0 truncate text-slate-600">{item.address || [item.city, item.state, item.zip].filter(Boolean).join(", ")}</span>
                </li>
              ))}
            </ul>
            {waitingCount > WAITING_SHOWN && <p className="text-xs text-cyan-800">and {waitingCount - WAITING_SHOWN} more</p>}
          </section>
        )}
      </Card>
      {/* Map three quarters, the top-states chart beside it at the same height (about a third of the screen,
          legend included); stacked on narrow screens. */}
      <div className="grid gap-3 lg:h-[50vh] lg:min-h-[416px] lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
        <div className="flex h-[50vh] min-h-0 flex-col lg:h-auto">
          <MapView
            unit={unit}
            className="min-h-0 flex-1"
            action={<OpenFullPage projectId={project.id} view="map" label="Open map in a new tab" />}
            pins={pins.data ?? []}
            selectedId={ui.selectedId}
            hoveredId={ui.hoveredId}
            onSelect={open}
            onBoundsChange={ui.setBounds}
          />
        </div>
        {/* Top states (scrolls when long), then the hardware cost of the same filtered stores. */}
        <div className="flex min-h-0 flex-col gap-3">
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-xl">
            <Suspense fallback={<Card className="h-56 animate-pulse bg-slate-50" aria-label="Top states (loading)" />}>
              <TopStatesChart
                data={byState.data ?? []}
                selected={ui.facets.state}
                // Every state, read only here (the panel scrolls); the full-page chart filters on click.
                unit={unit}
                className="min-h-full"
                action={<OpenFullPage projectId={project.id} view="states" label="Open chart in a new tab" />}
              />
            </Suspense>
          </div>
          {!project.hardware_costs.hidden && <HardwareCostChart counts={hardware.data} costs={project.hardware_costs} projectId={project.id} />}
        </div>
      </div>
      {/* As tall as its rows, up to three quarters of the screen (then the rows scroll): no empty band under a short
          page. */}
      <div className="flex max-h-[75vh] flex-col">
        {list.isPending ? (
          <Card className="flex-1 items-center justify-center font-mono text-sm text-slate-500">Loading {noun}…</Card>
        ) : list.isError ? (
          <Card className="flex-1 items-center justify-center gap-3 text-sm text-rose-700">
            Could not load {noun}: {list.error.message}
            <Button variant="outline" size="sm" onClick={() => list.refetch()}>
              Retry
            </Button>
          </Card>
        ) : total === 0 ? (
          <Card className="flex-1 items-center justify-center font-mono text-sm text-slate-500">
            {bounds ? `No ${noun} in the current map view.` : `No ${noun} match these filters.`}
          </Card>
        ) : byScreen ? (
          <ScreensTable project={project} rows={screenList.data?.items ?? []} {...paging} {...rowState} onOpen={open} />
        ) : (
          <StoresTable project={project} stops={storeList.data?.items ?? []} {...paging} {...rowState} onOpen={open} />
        )}
      </div>
      <StoreDrawer project={project} stopId={ui.selectedId} open={ui.drawerOpen} onClose={ui.closeDrawer} />
    </div>
  );
}
