import { lazy, Suspense, useEffect, useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Card } from "@/components/ui/card";
import { MapView } from "@/components/map/MapView";
import { useProject } from "@/features/projects/api";
import { useFilterOptions, usePins, useStoresByState } from "@/features/stores/api";
import { FilterBar } from "@/features/stores/FilterBar";
import { toStoreFilters } from "@/features/stores/filters";
import { StoresToolbar } from "@/features/stores/StoresToolbar";
import { UnitToggle } from "@/features/stores/StoresViewControls";
import type { StoreFilters } from "@/lib/api/resources";
import { useStoresUi, viewFromParams, viewToParams } from "@/stores/ui";

const TopStatesChart = lazy(() => import("@/features/stores/TopStatesChart"));

/** The project's map or top-states chart on a page of its own (opened in a new tab from the Stores tab), with the
 *  same search, filters and Locations / Screens switch. The address bar keeps them, so a reload or a shared link
 *  shows the same view. */
export function StoresFullPage({ view }: { view: "map" | "states" }) {
  const { projectId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const project = useProject(projectId);
  const ui = useStoresUi(
    useShallow((state) => ({
      projectId: state.projectId,
      facets: state.facets,
      search: state.search,
      unit: state.unit,
      loadView: state.loadView,
      toggleFacet: state.toggleFacet,
      toggleState: state.toggleState,
      setUnit: state.setUnit,
    })),
  );

  const needsAttention = useStoresUi((state) => state.needsAttention);
  // The link's filters, once, when the page opens.
  useEffect(() => ui.loadView(projectId, viewFromParams(params)), [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = ui.projectId === projectId;
  // Every change goes back into the address bar.
  useEffect(() => {
    if (ready) setParams(viewToParams({ search: ui.search, facets: ui.facets, unit: ui.unit, needsAttention }), { replace: true });
  }, [ready, ui.search, ui.facets, ui.unit, needsAttention, setParams]);

  const selection = useMemo(() => toStoreFilters(ui.facets, ui.search, needsAttention), [ui.facets, ui.search, needsAttention]);
  const filters: StoreFilters = useMemo(() => ({ ...selection, sort: "store_name", dir: "asc" }), [selection]);
  const pins = usePins(projectId, selection);
  const options = useFilterOptions(projectId, selection);
  const byState = useStoresByState(projectId, selection, ui.unit === "screens" ? "screens" : "stores");

  if (project.isPending || !ready) return <p className="p-6 text-center font-mono text-sm text-slate-500">Loading…</p>;
  if (project.isError) return <p className="p-6 text-center text-sm text-rose-700">Could not load the project: {project.error.message}</p>;

  return (
    <section className="flex h-[calc(100vh-5.5rem)] flex-col gap-3" aria-label={view === "map" ? "Stores map" : "Top states"}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <Link
            to={`/projects/${encodeURIComponent(projectId)}/stores`}
            className="inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-wider text-slate-500 hover:text-brand"
          >
            <ArrowLeft size={12} /> Stores
          </Link>
          <h1 className="font-display text-2xl tracking-[3px]">
            {project.data.name} · {view === "map" ? "Map" : "Top states"}
          </h1>
        </div>
        <UnitToggle value={ui.unit} onChange={ui.setUnit} />
      </div>
      <StoresToolbar project={project.data} filters={filters} minimal>
        <FilterBar options={options.data} facets={ui.facets} onToggle={ui.toggleFacet} />
      </StoresToolbar>
      {view === "map" ? (
        <MapView className="min-h-0 flex-1" pins={pins.data ?? []} unit={ui.unit} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Suspense fallback={<Card className="h-56 animate-pulse bg-slate-50" aria-label="Top states (loading)" />}>
            <TopStatesChart data={byState.data ?? []} selected={ui.facets.state} onToggle={ui.toggleState} unit={ui.unit} large />
          </Suspense>
        </div>
      )}
    </section>
  );
}
