import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Download, Search, X } from "lucide-react";
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
import { cn } from "@/lib/utils";

/** One row: a compact search, the filter dropdowns (`children`), then "only in view", clear and CSV export. */
export function StoresToolbar({
  project,
  filters,
  children,
  minimal = false,
}: {
  project: Project;
  filters: StoreFilters;
  children?: ReactNode;
  /** The full-page map and chart: search and filters only (no table to limit or export). */
  minimal?: boolean;
}) {
  // Only the slices the toolbar shows: hover, selection and map bounds never re-render it.
  const ui = useStoresUi(
    useShallow((state) => ({
      search: state.search,
      facets: state.facets,
      onlyInView: state.onlyInView,
      setSearch: state.setSearch,
      needsAttention: state.needsAttention,
      setNeedsAttention: state.setNeedsAttention,
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
  const active = ui.search || anyFacet(ui.facets) || ui.onlyInView || ui.needsAttention;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div className="relative w-64 shrink-0">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <Input
          aria-label="Search stores"
          placeholder="Search IBC#, name, address, ZIP…"
          title="Search IBC#, name, address, ZIP, DD code, comment"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="h-8 pl-9 text-sm"
        />
      </div>
      {children}
      {ui.needsAttention && (
        <Button
          size="sm"
          variant="outline"
          className="border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
          aria-pressed
          onClick={() => ui.setNeedsAttention(false)}
          title="Showing only stores added without a name or a verified address"
        >
          <AlertTriangle /> Needs attention <X />
        </Button>
      )}
      {!minimal && (
        <div className="ml-auto flex items-center gap-1.5">
          <Checkbox id="only-in-view" checked={ui.onlyInView} onCheckedChange={(checked) => ui.setOnlyInView(checked === true)} />
          <Label htmlFor="only-in-view" className="text-xs">
            Only stores in map view
          </Label>
        </div>
      )}
      {active ? (
        <Button variant="ghost" size="sm" className={cn(minimal && "ml-auto")} onClick={ui.clearFilters}>
          <X /> Clear
        </Button>
      ) : null}
      {!minimal && (
        <Button asChild variant="outline" size="sm">
          <a href={storeExportUrl(project.id, filters)} download>
            <Download /> CSV
          </a>
        </Button>
      )}
    </div>
  );
}
