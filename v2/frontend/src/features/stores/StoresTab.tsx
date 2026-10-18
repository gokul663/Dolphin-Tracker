import { useCallback, useEffect, useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MapView } from "@/components/map/MapView";
import { inBounds } from "@/components/map/pins";
import { useProjectContext } from "@/features/projects/ProjectPage";
import { usePins, useStoreList } from "@/features/stores/api";
import { StoreDrawer } from "@/features/stores/StoreDrawer";
import { StoresTable } from "@/features/stores/StoresTable";
import { StoresToolbar } from "@/features/stores/StoresToolbar";
import type { StoreFilters } from "@/lib/api/resources";
import { useShallow } from "zustand/react/shallow";
import { useStoresUi } from "@/stores/ui";

/** Table left, synced map right (stacked on narrow screens), both driven by the same filters. */
export function StoresTab() {
  const project = useProjectContext();
  const ui = useStoresUi(
    useShallow((state) => ({
      status: state.status,
      installer: state.installer,
      search: state.search,
      sort: state.sort,
      dir: state.dir,
      onlyInView: state.onlyInView,
      selectedId: state.selectedId,
      hoveredId: state.hoveredId,
      drawerOpen: state.drawerOpen,
      enterProject: state.enterProject,
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

  const filters: StoreFilters = useMemo(
    () => ({ status: ui.status, installer: ui.installer, q: ui.search, sort: ui.sort, dir: ui.dir }),
    [ui.status, ui.installer, ui.search, ui.sort, ui.dir],
  );
  const list = useStoreList(project.id, filters);
  const pins = usePins(project.id, { status: ui.status, installer: ui.installer, q: ui.search });

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
        <MapView
          className="h-[50vh] lg:h-auto"
          pins={pins.data ?? []}
          selectedId={ui.selectedId}
          hoveredId={ui.hoveredId}
          onSelect={open}
          onBoundsChange={ui.setBounds}
        />
      </div>
      <StoreDrawer project={project} stopId={ui.selectedId} open={ui.drawerOpen} onClose={ui.closeDrawer} />
    </div>
  );
}
