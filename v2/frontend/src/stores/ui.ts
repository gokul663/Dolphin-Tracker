import { create } from "zustand";
import type { Bounds, MapUnit } from "@/components/map/pins";

export type SortDir = "asc" | "desc";

/** The Stores tab filters, in STORE-MODEL §5 order. Each holds the selected values (OR within, AND across). */
export const FACETS = ["status", "route", "visit", "installer", "pa", "state", "city", "dma", "venue_type", "dd_code", "screen_size"] as const;
export type Facet = (typeof FACETS)[number];
export type FacetSelection = Record<Facet, string[]>;

export const NO_FACETS: FacetSelection = Object.fromEntries(FACETS.map((facet) => [facet, []])) as unknown as FacetSelection;

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

const FILTERS = { search: "", facets: NO_FACETS, sort: "store_name", dir: "asc" as SortDir, onlyInView: false, needsAttention: false };

/** The part of the Stores state a link carries: search, filters and the count unit. */
export interface StoresView {
  search: string;
  facets: FacetSelection;
  unit: MapUnit;
  needsAttention?: boolean;
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
  return params;
}

export function viewFromParams(params: URLSearchParams): StoresView {
  const facets = Object.fromEntries(FACETS.map((facet) => [facet, params.getAll(facet)])) as unknown as FacetSelection;
  return {
    search: params.get(SEARCH_PARAM) ?? "",
    facets,
    unit: params.get(UNIT_PARAM) === "screens" ? "screens" : "locations",
    ...(params.get("attention") === "1" ? { needsAttention: true } : {}),
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
        : { projectId, ...FILTERS, unit: "locations", bounds: null, selectedId: null, hoveredId: null, drawerOpen: false },
    ),
  setUnit: (unit) => set({ unit }),
  setNeedsAttention: (needsAttention) => set({ needsAttention }),
  loadView: (projectId, view) =>
    set({ projectId, ...FILTERS, ...view, bounds: null, selectedId: null, hoveredId: null, drawerOpen: false }),
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
