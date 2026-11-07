import { useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { facetDisabled, facetOptions, facetSummary, optionLabel } from "@/features/stores/filters";
import type { ScreenStatus, StoreFilterOptions } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";
import { cn } from "@/lib/utils";
import { FACETS, type Facet, type FacetSelection } from "@/stores/ui";

interface Props {
  options: StoreFilterOptions | undefined;
  facets: FacetSelection;
  onToggle: (facet: Facet, value: string) => void;
}

/** Short, fixed lists need no search box; every other filter gets one above its values. */
const UNSEARCHED: ReadonlySet<Facet> = new Set(["status", "visit", "screen_size", "route"]);

/** One dropdown per filter in STORE-MODEL §5 order; values come with store counts under the other filters. */
export function FilterBar({ options, facets, onToggle }: Props) {
  return (
    <div className="flex min-w-0 flex-wrap gap-1.5" role="group" aria-label="Filters">
      {FACETS.map((facet) => {
        const selected = facets[facet];
        const disabled = facetDisabled(options, facet, selected);
        return (
          <DropdownMenu key={facet}>
            <DropdownMenuTrigger asChild disabled={disabled}>
              <Button
                variant="outline"
                size="sm"
                aria-label={disabled ? `${facetSummary(facet, selected)} (no values)` : facetSummary(facet, selected)}
                title={disabled ? "No store in this project has a value for this filter" : undefined}
                className={cn("max-w-52 font-mono text-[11px]", selected.length > 0 && "border-slate-800 bg-slate-800 text-white hover:bg-slate-700 hover:text-white")}
              >
                <span className="truncate">{facetSummary(facet, selected)}</span>
                {disabled ? <span className="text-[10px] text-slate-400">no values</span> : <ChevronDown />}
              </Button>
            </DropdownMenuTrigger>
            <FacetMenu facet={facet} options={options} selected={selected} onToggle={onToggle} />
          </DropdownMenu>
        );
      })}
    </div>
  );
}

function FacetMenu({ facet, options, selected, onToggle }: { facet: Facet; options: StoreFilterOptions | undefined; selected: string[]; onToggle: Props["onToggle"] }) {
  const [query, setQuery] = useState("");
  const searchable = !UNSEARCHED.has(facet);
  const needle = query.trim().toLowerCase();
  const all = facetOptions(options, facet, selected);
  const shown = needle ? all.filter((option) => optionLabel(facet, option.value).toLowerCase().includes(needle)) : all;
  return (
    <DropdownMenuContent align="start" className="w-64 p-0" onCloseAutoFocus={() => setQuery("")}>
      {searchable && (
        <div className="relative border-b p-1.5">
          <Search size={13} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            autoFocus
            aria-label={`Search ${facetSummary(facet, [])}`}
            placeholder="Search…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            // Keep typing in the box: the menu would otherwise jump to items by letter and steal focus.
            onKeyDown={(event) => event.key !== "Escape" && event.stopPropagation()}
            className="h-7 w-full rounded-md border bg-white pl-7 pr-2 text-sm outline-none focus:border-slate-400"
          />
        </div>
      )}
      <div className="max-h-72 overflow-y-auto p-1">
        {shown.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-slate-400">No match</p>
        ) : (
          shown.map((option) => (
            <DropdownMenuCheckboxItem
              key={option.value || "(blank)"}
              checked={selected.includes(option.value)}
              onCheckedChange={() => onToggle(facet, option.value)}
              onSelect={(event) => event.preventDefault()}
            >
              {facet === "status" && (
                <span className="size-2 rounded-full" style={{ background: STATUS_META[option.value as ScreenStatus]?.color }} />
              )}
              <span className="flex-1">{optionLabel(facet, option.value)}</span>
              <span className="font-mono text-[10px] text-slate-400">{option.count}</span>
            </DropdownMenuCheckboxItem>
          ))
        )}
      </div>
    </DropdownMenuContent>
  );
}
