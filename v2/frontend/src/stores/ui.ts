import { create } from "zustand";

export type StoreStatus = "Incomplete" | "Complete" | "Technical Issue" | "Other";

interface UiState {
  /** Statuses shown on the map and in lists; empty set means all. */
  statusFilter: Set<StoreStatus>;
  search: string;
  selectedStoreId: string | null;
  setSearch: (value: string) => void;
  toggleStatus: (status: StoreStatus) => void;
  selectStore: (id: string | null) => void;
}

/** UI-only state. Server data lives in TanStack Query, never here. */
export const useUiStore = create<UiState>((set) => ({
  statusFilter: new Set(),
  search: "",
  selectedStoreId: null,
  setSearch: (search) => set({ search }),
  toggleStatus: (status) =>
    set((state) => {
      const next = new Set(state.statusFilter);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return { statusFilter: next };
    }),
  selectStore: (selectedStoreId) => set({ selectedStoreId }),
}));
