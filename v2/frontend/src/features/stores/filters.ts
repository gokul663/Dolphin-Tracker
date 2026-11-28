/** Filter bar logic (STORE-MODEL §5). Pure. */
import type { StoreFilters } from "@/lib/api/resources";
import type { FilterOption, ScreenStatus, StoreFilterOptions } from "@/lib/api/types";
import { BUCKET_LABEL, STATUS_META, storeStatusLabel, type StatusBucket } from "@/lib/status";
import {
  comparisonParam, DATE_RANGES, isRelative, NUMBER_FILTERS, numberActive, rangeActive,
  type CompareOp, type DateRange, type DateRangeFilter, type DateRanges, type DayRange, type Facet, type FacetSelection,
  type Nearby, type NumberComparison, type NumberFilter, type NumberFilters,
} from "@/stores/ui";

/** Filter names in Title Case, written out here (not CSS `capitalize`) so DMA, DD, PA and ExtID stay as they are. */
export const FACET_LABELS: Record<Facet, string> = {
  bucket: "Status Group",
  status: "Status",
  install_type: "Install Type",
  mount: "Mount",
  fulfilled: "Screens Done",
  review: "Review Notes",
  route: "Route",
  visit: "Visits",
  technician: "Technician",
  pa: "PA",
  state: "State",
  city: "City",
  dma: "DMA",
  venue_type: "Venue Type",
  dd_code: "DD Code",
  screen_size: "Screen Size",
  committed_over_installed: "Committed > Installed",
  installer: "Installer",
  tag: "Tag",
};

export const NUMBER_LABELS: Record<NumberFilter, string> = {
  screens_committed: "Screens Committed",
  screens_installed: "Screens Installed",
  mounts_needed: "Mounts Needed",
  mounts_installed: "Mounts Installed",
};

/** The operators: the symbol on the button and in the chip, the full name for screen readers. */
export const COMPARE_LABELS: Record<CompareOp, { symbol: string; name: string }> = {
  gt: { symbol: ">", name: "Higher than" },
  lt: { symbol: "<", name: "Lower than" },
  eq: { symbol: "=", name: "Equal to" },
};

/** "Screens Committed > 2". */
export const numberChipLabel = (name: NumberFilter, comparison: NumberComparison) =>
  `${NUMBER_LABELS[name]} ${COMPARE_LABELS[comparison.op].symbol} ${Number(comparison.value)}`;

export const RANGE_LABELS: Record<DateRangeFilter, string> = {
  first_registered: "First Registration Date",
  last_registered: "Last Registration Date",
};

/** The choice in words: "Today", "Last 7 Days", "Last 2 Weeks", "2026-01-01 – 2026-03-31", "From …", "Until …". */
export function rangeText(range: DateRange): string {
  if (isRelative(range)) {
    if (range.unit === "days" && range.n === 1) return "Today";
    return `Last ${range.n} ${range.unit === "weeks" ? (range.n === 1 ? "Week" : "Weeks") : "Days"}`;
  }
  return range.from && range.to ? `${range.from} – ${range.to}` : range.from ? `From ${range.from}` : `Until ${range.to}`;
}

/** "First Registration Date: Last 7 Days". */
export function rangeChipLabel(name: DateRangeFilter, range: DateRange): string {
  return `${RANGE_LABELS[name]}: ${rangeText(range)}`;
}

/** A day of the user's local calendar as YYYY-MM-DD. */
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** The concrete days a range stands for on `today`, both inclusive, on the user's local calendar. "Last N days" is
 *  today and the N − 1 days before it, so "Today" (the last 1 day) is today only and "Last 7 Days" is today and the 6
 *  days before; "Last N weeks" is the last 7 × N days the same way. An absolute range is returned as it is. */
export function resolveRange(range: DateRange, today: Date): DayRange {
  if (!isRelative(range)) return range;
  const days = range.n * (range.unit === "weeks" ? 7 : 1);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
  return { from: localDay(start), to: localDay(today) };
}

/** "Within 10 mi of 1 Main St, Atlanta, GA". */
export const nearChipLabel = (near: Nearby) => `Within ${near.radius} mi of ${near.address || `${near.lat.toFixed(4)}, ${near.lng.toFixed(4)}`}`;

export function optionLabel(facet: Facet, value: string): string {
  if (facet === "status") return value in STATUS_META ? storeStatusLabel(value as ScreenStatus) : value; // a store's status
  if (facet === "bucket") return BUCKET_LABEL[value as StatusBucket] ?? value;
  if (facet === "technician" && value === "") return "No technician";
  if (facet === "installer" && value === "") return "Unassigned";
  if (facet === "tag" && value === "") return "No tag";
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

/** The API query for the current selection: the facets, the search, and (when set) the day ranges, the number
 *  comparisons and Nearby. Relative day ranges become dates as of `today` (injected by tests). */
export function toStoreFilters(
  facets: FacetSelection,
  search: string,
  needsAttention = false,
  more: { ranges?: DateRanges; near?: Nearby | null; numbers?: NumberFilters; today?: Date } = {},
): StoreFilters {
  const ranges: StoreFilters = {};
  for (const name of DATE_RANGES) {
    const chosen = more.ranges?.[name];
    if (!chosen || !rangeActive(chosen)) continue;
    const range = resolveRange(chosen, more.today ?? new Date());
    if (range.from) ranges[`${name}_from`] = range.from;
    if (range.to) ranges[`${name}_to`] = range.to;
  }
  for (const name of NUMBER_FILTERS) {
    const value = more.numbers ? comparisonParam(more.numbers[name]) : null;
    if (value) ranges[name] = value;
  }
  const near = more.near ? { near_lat: more.near.lat, near_lng: more.near.lng, radius_miles: more.near.radius } : {};
  return {
    ...facets, status: facets.status as ScreenStatus[], bucket: facets.bucket as StatusBucket[], q: search,
    ...(needsAttention ? { needs_attention: true } : {}), ...ranges, ...near,
  };
}

export const anyRange = (ranges: DateRanges) => DATE_RANGES.some((name) => rangeActive(ranges[name]));

export const anyNumber = (numbers: NumberFilters) => NUMBER_FILTERS.some((name) => numberActive(numbers[name]));

export const anyFacet = (facets: FacetSelection) => Object.values(facets).some((values) => values.length > 0);
