import type { PoolFilters, StoreFilters } from "@/lib/api/resources";
import type { Bounds } from "@/components/map/pins";

/** Which page of the store list: rows from `offset`, `limit` of them, only inside `bounds` when set. */
export interface StorePageParams {
  offset: number;
  limit: number;
  bounds: Bounds | null;
}

/** TanStack Query keys. Prefix-based so `invalidateQueries({ queryKey: keys.project(id) })` clears its children. */
export const keys = {
  health: ["health"] as const,
  mapsConfig: ["config", "maps"] as const,
  storeFields: ["config", "store-fields"] as const,
  projects: ["projects"] as const,
  projectList: (limit: number) => ["projects", "list", limit] as const,
  project: (id: string) => ["projects", id] as const,
  routes: (id: string) => ["projects", id, "routes"] as const,
  stores: (id: string) => ["projects", id, "stores"] as const,
  storeList: (id: string, filters: StoreFilters, page: StorePageParams = { offset: 0, limit: 20, bounds: null }) =>
    ["projects", id, "stores", "list", filters, page] as const,
  pins: (id: string, filters: StoreFilters) => ["projects", id, "stores", "pins", filters] as const,
  storeFacets: (id: string, filters: StoreFilters) => ["projects", id, "stores", "facets", filters] as const,
  byState: (id: string, filters: StoreFilters) => ["projects", id, "stores", "by-state", filters] as const,
  store: (id: string, uid: string) => ["projects", id, "stores", "one", uid] as const,
  visits: (id: string, uid: string) => ["projects", id, "stores", "visits", uid] as const,
  routePlans: ["route-plans"] as const,
  routePlanList: (status: string) => ["route-plans", "list", status] as const,
  routePlan: (id: string) => ["route-plans", id] as const,
  storeSearch: ["store-search"] as const,
  storeSearchPins: (filters: PoolFilters) => ["store-search", "pins", filters] as const,
  storeSearchFacets: (filters: PoolFilters) => ["store-search", "facets", filters] as const,
  names: (kind: string) => ["lists", kind] as const,
  categories: ["lists", "categories"] as const,
  job: (jobId: string) => ["jobs", jobId] as const,
  jobResult: (jobId: string) => ["jobs", jobId, "result"] as const,
};
