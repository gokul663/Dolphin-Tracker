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
import { DateRangeFilter } from "@/features/stores/DateRangeFilter";
import { INLINE_FACETS, MoreFilters } from "@/features/stores/MoreFilters";
import type { ScreenStatus, StoreFilterOptions } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";
import { cn, FILTER_TRIGGER } from "@/lib/utils";
import { DATE_RANGES, type Facet, type FacetSelection } from "@/stores/ui";

interface Props {
  options: StoreFilterOptions | undefined;
  facets: FacetSelection;
  onToggle: (facet: Facet, value: string) => void;
}

/** Short, fixed lists need no search box; every other filter gets one above its values. */
const UNSEARCHED: ReadonlySet<Facet> = new Set(["status", "visit", "screen_size", "route", "install_type", "mount", "fulfilled", "review", "committed_over_installed"]);
/** Shown as chips of their own (`BucketChips`), not as a dropdown. */
const AS_CHIPS: ReadonlySet<Facet> = new Set(["bucket"]);

/** The most-used filters, inline in this order (then the two registration dates); every filter (these too) is in the
 *  More Filters panel, and the status groups are chips of their own. */
export const SHOWN_FACETS: readonly Facet[] = INLINE_FACETS;

/** One dropdown per inline filter, then More filters; values come with store counts under the other filters. PA is
 *  left out while the project has a single PA (nothing to choose). */
export function FilterBar({ options, facets, onToggle }: Props) {
  const shown = SHOWN_FACETS.filter(
    (facet) => !AS_CHIPS.has(facet) && !(facet === "pa" && (options?.pa?.length ?? 0) <= 1 && facets.pa.length === 0),
  );
  return (
    <div className="flex min-w-0 flex-wrap gap-1.5" role="group" aria-label="Filters">
      {shown.map((facet) => {
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
                className={cn(FILTER_TRIGGER, "max-w-52", // Tinted, not inverted: it stays readable when the filter has nothing else to offer (disabled).
                  selected.length > 0 && "border-brand/40 bg-brand/10 text-brand hover:bg-brand/15 hover:text-brand disabled:opacity-100")}
              >
                <span className="truncate">{facetSummary(facet, selected)}</span>
                {disabled ? <span className="text-[11px] text-slate-400">no values</span> : <ChevronDown />}
              </Button>
            </DropdownMenuTrigger>
            <FacetMenu facet={facet} options={options} selected={selected} onToggle={onToggle} />
          </DropdownMenu>
        );
      })}
      {DATE_RANGES.map((name) => (
        <DateRangeFilter key={name} name={name} />
      ))}
      <MoreFilters options={options} />
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
              <span className="font-mono text-xs text-slate-400">{option.count}</span>
            </DropdownMenuCheckboxItem>
          ))
        )}
      </div>
    </DropdownMenuContent>
  );
}
