import { create } from "zustand";
import type { Bounds } from "@/components/map/pins";

export type SortDir = "asc" | "desc";

/** The Stores tab filters, in STORE-MODEL §5 order. Each holds the selected values (OR within, AND across). */
export const FACETS = ["status", "installer", "pa", "state", "city", "dma", "venue_type", "dd_code", "screen_size"] as const;
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
  enterProject: (projectId: string) => void;
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

const FILTERS = { search: "", facets: NO_FACETS, sort: "store_name", dir: "asc" as SortDir, onlyInView: false };

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
  enterProject: (projectId) =>
    set((state) =>
      state.projectId === projectId
        ? state
        : { projectId, ...FILTERS, bounds: null, selectedId: null, hoveredId: null, drawerOpen: false },
    ),
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
