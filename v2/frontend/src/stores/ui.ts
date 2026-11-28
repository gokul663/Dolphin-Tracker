import { create } from "zustand";
import type { Bounds, MapUnit } from "@/components/map/pins";

export type SortDir = "asc" | "desc";

/** The Stores tab filters, in STORE-MODEL §5 order. Each holds the selected values (OR within, AND across). */
export const FACETS = [
  "bucket", "status", "route", "visit", "technician", "install_type", "pa", "state", "city", "dma", "venue_type", "dd_code",
  "screen_size", "mount", "fulfilled", "review",
  // The More filters panel's: committed > installed, the routing installer, the tag.
  "committed_over_installed", "installer", "tag",
] as const;
export type Facet = (typeof FACETS)[number];
export type FacetSelection = Record<Facet, string[]>;

export const NO_FACETS: FacetSelection = Object.fromEntries(FACETS.map((facet) => [facet, []])) as unknown as FacetSelection;

/** The store's worked-out numbers, each filtered by a comparison: "Screens committed > 2". */
export const NUMBER_FILTERS = ["screens_committed", "screens_installed", "mounts_needed", "mounts_installed"] as const;
export type NumberFilter = (typeof NUMBER_FILTERS)[number];
export const COMPARE_OPS = ["gt", "lt", "eq"] as const;
export type CompareOp = (typeof COMPARE_OPS)[number];
/** `value` is the digits typed; "" turns the filter off (the operator is kept for the next number). */
export interface NumberComparison {
  op: CompareOp;
  value: string;
}
export type NumberFilters = Record<NumberFilter, NumberComparison>;
export const NO_NUMBERS: NumberFilters = Object.fromEntries(NUMBER_FILTERS.map((name) => [name, { op: "gt", value: "" }])) as unknown as NumberFilters;
export const numberActive = (comparison: NumberComparison) => /^\d+$/.test(comparison.value);
const COMPARISON = /^(gt|lt|eq):(\d{1,6})$/;
/** "gt:2" for the API and the address bar; null while off. */
export const comparisonParam = (comparison: NumberComparison) => (numberActive(comparison) ? `${comparison.op}:${Number(comparison.value)}` : null);

/** Day ranges on the screens' device data: a store matches when any screen registered within the range. */
export const DATE_RANGES = ["first_registered", "last_registered"] as const;
export type DateRangeFilter = (typeof DATE_RANGES)[number];
/** An absolute range: YYYY-MM-DD, both inclusive; "" leaves that end open. */
export interface DayRange {
  from: string;
  to: string;
}
/** A range that moves with the calendar: the last `n` days or weeks, today included ("Today" is the last 1 day).
 *  It stays relative in the view and the link, and becomes dates only for the request (`resolveRange`). */
export interface RelativeRange {
  kind: "last";
  n: number;
  unit: "days" | "weeks";
}
export type DateRange = DayRange | RelativeRange;
export type DateRanges = Record<DateRangeFilter, DateRange>;
export const NO_RANGE: DayRange = { from: "", to: "" };
export const NO_RANGES: DateRanges = { first_registered: NO_RANGE, last_registered: NO_RANGE };
export const isRelative = (range: DateRange): range is RelativeRange => "kind" in range && range.kind === "last";
export const rangeActive = (range: DateRange) => (isRelative(range) ? range.n > 0 : Boolean(range.from || range.to));

/** The Nearby filter: this project's stores within `radius` miles of a point found from `address`. */
export interface Nearby {
  lat: number;
  lng: number;
  radius: number;
  /** As the person picked it, for the chip; the server only needs the point. */
  address: string;
}

/** The store last clicked on the map: the Nearby form starts from it. `seq` tells a new click from the same one. */
export interface PickedStore {
  uid: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  seq: number;
}

interface StoresUiState {
  /** Filters belong to one project; switching projects starts clean. */
  projectId: string | null;
  search: string;
  facets: FacetSelection;
  sort: string;
  dir: SortDir;
  onlyInView: boolean;
  bounds: Bounds | null;
  selectedId: string | null;
  hoveredId: string | null;
  drawerOpen: boolean;
  /** What the map and the top-states chart count. */
  unit: MapUnit;
  /** Only the stores added without a name or a verified address. */
  needsAttention: boolean;
  /** The registration-day ranges (More filters). */
  ranges: DateRanges;
  /** Stores within a radius of a point (the map's Nearby control). */
  near: Nearby | null;
  setRange: (name: DateRangeFilter, range: DateRange) => void;
  /** The number comparisons (More filters). */
  numbers: NumberFilters;
  setNumber: (name: NumberFilter, comparison: NumberComparison) => void;
  /** The last store clicked on the map, to pre-fill the Nearby form; null until one is. */
  lastStore: PickedStore | null;
  pickStore: (store: Omit<PickedStore, "seq">) => void;
  /** The Nearby form is open (its button, or a map pop-up's Nearby action). */
  nearbyOpen: boolean;
  setNearbyOpen: (open: boolean) => void;
  /** Turning Nearby on sorts the table nearest first; turning it off leaves the distance sort. */
  setNear: (near: Nearby | null) => void;
  /** The More filters panel's Clear all: every filter it shows (the status-group chips and Nearby stay). */
  clearPanelFilters: () => void;
  setNeedsAttention: (value: boolean) => void;
  enterProject: (projectId: string) => void;
  setUnit: (unit: MapUnit) => void;
  /** Open a project with the filters from a link (the full-page map and chart open in their own tab). */
  loadView: (projectId: string, view: StoresView) => void;
  setSearch: (search: string) => void;
  toggleFacet: (facet: Facet, value: string) => void;
  /** The top-states chart: a state bar selects that state alone; clicking the selected bar clears State. */
  toggleState: (state: string) => void;
  setSort: (sort: string) => void;
  setOnlyInView: (value: boolean) => void;
  setBounds: (bounds: Bounds) => void;
  hover: (uid: string | null) => void;
  select: (uid: string | null, openDrawer?: boolean) => void;
  closeDrawer: () => void;
  clearFilters: () => void;
}

const FILTERS = {
  search: "", facets: NO_FACETS, sort: "store_name", dir: "asc" as SortDir, onlyInView: false, needsAttention: false,
  ranges: NO_RANGES as DateRanges, near: null as Nearby | null, numbers: NO_NUMBERS,
};

/** The part of the Stores state a link carries: search, filters and the count unit. */
export interface StoresView {
  search: string;
  facets: FacetSelection;
  unit: MapUnit;
  needsAttention?: boolean;
  /** Present only when a range is set (a link without one reads back the same). */
  ranges?: DateRanges;
  near?: Nearby | null;
  /** Present only when a comparison is set. */
  numbers?: NumberFilters;
}

const UNIT_PARAM = "unit";
const SEARCH_PARAM = "q";

/** `?q=…&status=Upcoming&state=TX&unit=screens`: repeated keys for several values of one filter. */
export function viewToParams(view: StoresView): URLSearchParams {
  const params = new URLSearchParams();
  if (view.search) params.set(SEARCH_PARAM, view.search);
  for (const facet of FACETS) for (const value of view.facets[facet]) params.append(facet, value);
  if (view.unit !== "locations") params.set(UNIT_PARAM, view.unit);
  if (view.needsAttention) params.set("attention", "1");
  for (const name of NUMBER_FILTERS) {
    const value = view.numbers ? comparisonParam(view.numbers[name]) : null;
    if (value) params.set(name, value);
  }
  for (const name of DATE_RANGES) {
    const range = view.ranges?.[name];
    if (!range || !rangeActive(range)) continue;
    // Relative ranges stay relative in a link: "last:7d" means the last 7 days on whatever day it is opened.
    if (isRelative(range)) params.set(name, `last:${range.n}${range.unit === "weeks" ? "w" : "d"}`);
    else {
      if (range.from) params.set(`${name}_from`, range.from);
      if (range.to) params.set(`${name}_to`, range.to);
    }
  }
  if (view.near) {
    params.set("near_lat", String(view.near.lat));
    params.set("near_lng", String(view.near.lng));
    params.set("radius", String(view.near.radius));
    if (view.near.address) params.set("near", view.near.address);
  }
  return params;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const LAST = /^last:(\d{1,4})([dw])$/;

function rangesFromParams(params: URLSearchParams): DateRanges | null {
  const day = (key: string) => {
    const value = params.get(key) ?? "";
    return DAY.test(value) ? value : "";
  };
  const read = (name: DateRangeFilter): DateRange => {
    const last = LAST.exec(params.get(name) ?? "");
    if (last && Number(last[1]) > 0) return { kind: "last", n: Number(last[1]), unit: last[2] === "w" ? "weeks" : "days" };
    return { from: day(`${name}_from`), to: day(`${name}_to`) };
  };
  const ranges = Object.fromEntries(DATE_RANGES.map((name) => [name, read(name)])) as DateRanges;
  return DATE_RANGES.some((name) => rangeActive(ranges[name])) ? ranges : null;
}

/** "gt:2" per number filter; anything else (an old link's list of numbers, say) is ignored. */
function numbersFromParams(params: URLSearchParams): NumberFilters | null {
  let any = false;
  const numbers = Object.fromEntries(
    NUMBER_FILTERS.map((name) => {
      const match = COMPARISON.exec(params.get(name) ?? "");
      if (!match) return [name, NO_NUMBERS[name]];
      any = true;
      return [name, { op: match[1] as CompareOp, value: String(Number(match[2])) }];
    }),
  ) as unknown as NumberFilters;
  return any ? numbers : null;
}

function nearFromParams(params: URLSearchParams): Nearby | null {
  const [lat, lng, radius] = ["near_lat", "near_lng", "radius"].map((key) => (params.has(key) ? Number(params.get(key)) : NaN)) as [number, number, number];
  if (![lat, lng, radius].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || radius <= 0) return null;
  return { lat, lng, radius, address: params.get("near") ?? "" };
}

export function viewFromParams(params: URLSearchParams): StoresView {
  const ranges = rangesFromParams(params);
  const near = nearFromParams(params);
  const numbers = numbersFromParams(params);
  const facets = Object.fromEntries(FACETS.map((facet) => [facet, params.getAll(facet)])) as unknown as FacetSelection;
  return {
    search: params.get(SEARCH_PARAM) ?? "",
    facets,
    unit: params.get(UNIT_PARAM) === "screens" ? "screens" : "locations",
    ...(params.get("attention") === "1" ? { needsAttention: true } : {}),
    ...(ranges ? { ranges } : {}),
    ...(near ? { near } : {}),
    ...(numbers ? { numbers } : {}),
  };
}

export const toggleValue = (values: string[], value: string) =>
  values.includes(value) ? values.filter((item) => item !== value) : [...values, value];

/** UI-only state for the Stores tab. Server data (stores, pins, facet options) lives in TanStack Query, never here. */
export const useStoresUi = create<StoresUiState>((set) => ({
  projectId: null,
  ...FILTERS,
  bounds: null,
  selectedId: null,
  hoveredId: null,
  drawerOpen: false,
  unit: "locations",
  enterProject: (projectId) =>
    set((state) =>
      state.projectId === projectId
        ? state
        : { projectId, ...FILTERS, unit: "locations", bounds: null, selectedId: null, hoveredId: null, drawerOpen: false, lastStore: null, nearbyOpen: false },
    ),
  // Stores and screens sort by different columns: a switch starts from the default order.
  setUnit: (unit) => set((state) => (state.unit === unit ? state : { unit, sort: "store_name", dir: "asc" })),
  setNeedsAttention: (needsAttention) => set({ needsAttention }),
  setRange: (name, range) => set((state) => ({ ranges: { ...state.ranges, [name]: range } })),
  setNumber: (name, comparison) => set((state) => ({ numbers: { ...state.numbers, [name]: comparison } })),
  lastStore: null,
  pickStore: (store) => set((state) => ({ lastStore: { ...store, seq: (state.lastStore?.seq ?? 0) + 1 } })),
  nearbyOpen: false,
  setNearbyOpen: (nearbyOpen) => set({ nearbyOpen }),
  setNear: (near) =>
    set((state) => {
      if (near && !state.near) return { near, sort: "distance", dir: "asc" };
      if (!near && state.sort === "distance") return { near, sort: "store_name", dir: "asc" };
      return { near };
    }),
  clearPanelFilters: () => set({ facets: NO_FACETS, ranges: NO_RANGES, numbers: NO_NUMBERS }),
  loadView: (projectId, view) =>
    set({ projectId, ...FILTERS, ...view, bounds: null, selectedId: null, hoveredId: null, drawerOpen: false, lastStore: null, nearbyOpen: false }),
  setSearch: (search) => set({ search }),
  toggleFacet: (facet, value) => set((state) => ({ facets: { ...state.facets, [facet]: toggleValue(state.facets[facet], value) } })),
  toggleState: (value) =>
    set((state) => {
      const only = state.facets.state.length === 1 && state.facets.state[0] === value;
      return { facets: { ...state.facets, state: only ? [] : [value] } };
    }),
  /** Clicking the active column flips direction; a new column starts ascending. */
  setSort: (sort) => set((state) => (state.sort === sort ? { dir: state.dir === "asc" ? "desc" : "asc" } : { sort, dir: "asc" })),
  setOnlyInView: (onlyInView) => set({ onlyInView }),
  setBounds: (bounds) => set({ bounds }),
  hover: (hoveredId) => set({ hoveredId }),
  select: (selectedId, openDrawer = false) => set((state) => ({ selectedId, drawerOpen: openDrawer || state.drawerOpen })),
  closeDrawer: () => set({ drawerOpen: false }),
  clearFilters: () => set({ ...FILTERS }),
}));
