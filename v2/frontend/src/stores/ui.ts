import { create } from "zustand";
import type { Bounds } from "@/components/map/pins";
import type { StopStatus } from "@/lib/api/types";

export type SortDir = "asc" | "desc";

interface StoresUiState {
  /** Filters belong to one project; switching projects starts clean. */
  projectId: string | null;
  search: string;
  status: StopStatus[];
  installer: string[];
  sort: string;
  dir: SortDir;
  onlyInView: boolean;
  bounds: Bounds | null;
  selectedId: string | null;
  hoveredId: string | null;
  drawerOpen: boolean;
  enterProject: (projectId: string) => void;
  setSearch: (search: string) => void;
  toggleStatus: (status: StopStatus) => void;
  setInstaller: (installer: string[]) => void;
  setSort: (sort: string) => void;
  setOnlyInView: (value: boolean) => void;
  setBounds: (bounds: Bounds) => void;
  hover: (uid: string | null) => void;
  select: (uid: string | null, openDrawer?: boolean) => void;
  closeDrawer: () => void;
  clearFilters: () => void;
}

const FILTERS = { search: "", status: [] as StopStatus[], installer: [] as string[], sort: "store_name", dir: "asc" as SortDir, onlyInView: false };

/** UI-only state for the Stores tab. Server data (stores, pins) lives in TanStack Query, never here. */
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
  toggleStatus: (status) =>
    set((state) => ({
      status: state.status.includes(status) ? state.status.filter((s) => s !== status) : [...state.status, status],
    })),
  setInstaller: (installer) => set({ installer }),
  /** Clicking the active column flips direction; a new column starts ascending. */
  setSort: (sort) => set((state) => (state.sort === sort ? { dir: state.dir === "asc" ? "desc" : "asc" } : { sort, dir: "asc" })),
  setOnlyInView: (onlyInView) => set({ onlyInView }),
  setBounds: (bounds) => set({ bounds }),
  hover: (hoveredId) => set({ hoveredId }),
  select: (selectedId, openDrawer = false) => set((state) => ({ selectedId, drawerOpen: openDrawer || state.drawerOpen })),
  closeDrawer: () => set({ drawerOpen: false }),
  clearFilters: () => set({ ...FILTERS }),
}));
