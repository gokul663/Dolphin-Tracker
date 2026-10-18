import { ChevronDown } from "lucide-react";
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

/** One dropdown per filter in STORE-MODEL §5 order; values come with store counts under the other filters. */
export function FilterBar({ options, facets, onToggle }: Props) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filters">
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
            <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
              {facetOptions(options, facet, selected).map((option) => (
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
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      })}
    </div>
  );
}
