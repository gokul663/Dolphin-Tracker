/** Filter bar logic (STORE-MODEL §5). Pure. */
import type { StoreFilters } from "@/lib/api/resources";
import type { FilterOption, ScreenStatus, StoreFilterOptions } from "@/lib/api/types";
import { BUCKET_LABEL, STATUS_META, storeStatusLabel, type StatusBucket } from "@/lib/status";
import type { Facet, FacetSelection } from "@/stores/ui";

export const FACET_LABELS: Record<Facet, string> = {
  bucket: "Status group",
  status: "Status",
  install_type: "Install type",
  mount: "Mount",
  fulfilled: "Screens done",
  review: "Review notes",
  route: "Route",
  visit: "Visits",
  technician: "Technician",
  pa: "PA",
  state: "State",
  city: "City",
  dma: "DMA",
  venue_type: "Venue type",
  dd_code: "DD code",
  screen_size: "Screen size",
};

export function optionLabel(facet: Facet, value: string): string {
  if (facet === "status") return value in STATUS_META ? storeStatusLabel(value as ScreenStatus) : value; // a store's status
  if (facet === "bucket") return BUCKET_LABEL[value as StatusBucket] ?? value;
  if (facet === "technician" && value === "") return "No technician";
  return value;
}

/** The server's values for a filter. "No technician" alone is nothing to choose from: a project where nobody is
 *  assigned shows the Technician filter greyed out ("no values"). */
function listedOptions(options: StoreFilterOptions | undefined, facet: Facet): FilterOption[] {
  const listed = options?.[facet] ?? [];
  return facet === "technician" && listed.every((option) => option.value.trim() === "") ? [] : listed;
}

/** The server's options, plus any selected value it no longer lists (so it can still be unticked), at count 0. */
export function facetOptions(options: StoreFilterOptions | undefined, facet: Facet, selected: string[]): FilterOption[] {
  const listed = listedOptions(options, facet);
  const missing = selected.filter((value) => !listed.some((option) => option.value === value));
  return [...listed, ...missing.map((value) => ({ value, count: 0 }))];
}

/** A filter with nothing to choose is greyed out ("no values"), unless something is still selected in it. */
export function facetDisabled(options: StoreFilterOptions | undefined, facet: Facet, selected: string[]): boolean {
  return options !== undefined && listedOptions(options, facet).length === 0 && selected.length === 0;
}

export function facetSummary(facet: Facet, selected: string[]): string {
  if (selected.length === 0) return FACET_LABELS[facet];
  if (selected.length === 1) return `${FACET_LABELS[facet]}: ${optionLabel(facet, selected[0] as string)}`;
  return `${FACET_LABELS[facet]} (${selected.length})`;
}

/** The API query for the current selection. */
export function toStoreFilters(facets: FacetSelection, search: string, needsAttention = false): StoreFilters {
  return { ...facets, status: facets.status as ScreenStatus[], bucket: facets.bucket as StatusBucket[], q: search, ...(needsAttention ? { needs_attention: true } : {}) };
}

export const anyFacet = (facets: FacetSelection) => Object.values(facets).some((values) => values.length > 0);
