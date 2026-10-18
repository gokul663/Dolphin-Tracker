import { useEffect, useState } from "react";
import { Download, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { storeExportUrl } from "@/features/stores/api";
import type { StoreFilters } from "@/lib/api/resources";
import type { Project } from "@/lib/api/types";
import { useShallow } from "zustand/react/shallow";
import { useStoresUi } from "@/stores/ui";
import { anyFacet } from "@/features/stores/filters";

/** Search, "only in view", clear, CSV export of the current view. The filters are the FilterBar below. */
export function StoresToolbar({ project, filters }: { project: Project; filters: StoreFilters }) {
  // Only the slices the toolbar shows: hover, selection and map bounds never re-render it.
  const ui = useStoresUi(
    useShallow((state) => ({
      search: state.search,
      facets: state.facets,
      onlyInView: state.onlyInView,
      setSearch: state.setSearch,
      setOnlyInView: state.setOnlyInView,
      clearFilters: state.clearFilters,
    })),
  );
  const [draft, setDraft] = useState(ui.search);
  useEffect(() => setDraft(ui.search), [ui.search]);
  useEffect(() => {
    const timer = window.setTimeout(() => draft !== ui.search && ui.setSearch(draft), 250);
    return () => window.clearTimeout(timer);
  }, [draft]); // only the draft drives the debounce; `ui` is the stable store
  const active = ui.search || anyFacet(ui.facets) || ui.onlyInView;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-56 flex-1">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <Input
          aria-label="Search stores"
          placeholder="Search IBC#, name, address, ZIP, DD code, comment…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="pl-9"
        />
      </div>
      <div className="flex items-center gap-1.5">
        <Checkbox id="only-in-view" checked={ui.onlyInView} onCheckedChange={(checked) => ui.setOnlyInView(checked === true)} />
        <Label htmlFor="only-in-view" className="text-xs">
          Only stores in map view
        </Label>
      </div>
      {active ? (
        <Button variant="ghost" size="sm" onClick={ui.clearFilters}>
          <X /> Clear
        </Button>
      ) : null}
      <Button asChild variant="outline" size="sm">
        <a href={storeExportUrl(project.id, filters)} download>
          <Download /> CSV
        </a>
      </Button>
    </div>
  );
}
