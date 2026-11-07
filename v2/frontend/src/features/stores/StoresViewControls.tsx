import { ExternalLink } from "lucide-react";
import type { MapUnit } from "@/components/map/pins";
import { cn } from "@/lib/utils";
import { useStoresUi, viewToParams } from "@/stores/ui";

/** One switch for the map and the top-states chart: count locations (stores) or screens. */
export function UnitToggle({ value, onChange }: { value: MapUnit; onChange: (unit: MapUnit) => void }) {
  return (
    <div className="flex shrink-0 items-center gap-2" role="radiogroup" aria-label="Count by">
      <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">Count</span>
      <div className="flex rounded-lg border bg-white p-0.5">
        {(
          [
            ["locations", "Locations"],
            ["screens", "Screens"],
          ] as const
        ).map(([unit, label]) => (
          <button
            key={unit}
            type="button"
            role="radio"
            aria-checked={value === unit}
            onClick={() => onChange(unit)}
            className={cn("rounded-md px-3 py-1 text-xs font-medium", value === unit ? "bg-brand text-white" : "text-slate-600 hover:bg-slate-100")}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The full-page map or chart for this project, in a new tab, with the current search, filters and count unit. */
export function storesViewHref(projectId: string, view: "map" | "states"): string {
  const { search, facets, unit, needsAttention } = useStoresUi.getState();
  const query = viewToParams({ search, facets, unit, needsAttention }).toString();
  return `/projects/${encodeURIComponent(projectId)}/${view}${query ? `?${query}` : ""}`;
}

export function OpenFullPage({ projectId, view, label }: { projectId: string; view: "map" | "states"; label: string }) {
  return (
    <a
      href={`/projects/${encodeURIComponent(projectId)}/${view}`}
      target="_blank"
      rel="noopener"
      aria-label={label}
      title={label}
      // Built on click, so the link always carries the filters as they are now.
      onClick={(event) => {
        event.currentTarget.href = storesViewHref(projectId, view);
      }}
      className="inline-flex items-center gap-1 rounded-md border bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
    >
      <ExternalLink className="size-3.5" /> Full page
    </a>
  );
}
