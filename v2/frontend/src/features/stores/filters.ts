/** Filter bar logic (STORE-MODEL §5). Pure. */
import type { StoreFilters } from "@/lib/api/resources";
import type { FilterOption, ScreenStatus, StoreFilterOptions } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";
import type { Facet, FacetSelection } from "@/stores/ui";

export const FACET_LABELS: Record<Facet, string> = {
  status: "Status",
  route: "Route",
  visit: "Visits",
  installer: "Installer",
  pa: "PA",
  state: "State",
  city: "City",
  dma: "DMA",
  venue_type: "Venue type",
  dd_code: "DD code",
  screen_size: "Screen size",
};

export function optionLabel(facet: Facet, value: string): string {
  if (facet === "status") return STATUS_META[value as ScreenStatus]?.label ?? value;
  if (facet === "installer" && value === "") return "Unassigned";
  return value;
}

/** The server's options, plus any selected value it no longer lists (so it can still be unticked), at count 0. */
export function facetOptions(options: StoreFilterOptions | undefined, facet: Facet, selected: string[]): FilterOption[] {
  const listed = options?.[facet] ?? [];
  const missing = selected.filter((value) => !listed.some((option) => option.value === value));
  return [...listed, ...missing.map((value) => ({ value, count: 0 }))];
}

/** A filter with nothing to choose is greyed out ("no values"), unless something is still selected in it. */
export function facetDisabled(options: StoreFilterOptions | undefined, facet: Facet, selected: string[]): boolean {
  return options !== undefined && (options[facet]?.length ?? 0) === 0 && selected.length === 0;
}

export function facetSummary(facet: Facet, selected: string[]): string {
  if (selected.length === 0) return FACET_LABELS[facet];
  if (selected.length === 1) return `${FACET_LABELS[facet]}: ${optionLabel(facet, selected[0] as string)}`;
  return `${FACET_LABELS[facet]} (${selected.length})`;
}

/** The API query for the current selection. */
export function toStoreFilters(facets: FacetSelection, search: string): StoreFilters {
  return { ...facets, status: facets.status as ScreenStatus[], q: search };
}

export const anyFacet = (facets: FacetSelection) => Object.values(facets).some((values) => values.length > 0);
