import type { StoreFilters } from "@/lib/api/resources";

/** TanStack Query keys. Prefix-based so `invalidateQueries({ queryKey: keys.project(id) })` clears its children. */
export const keys = {
  health: ["health"] as const,
  mapsConfig: ["config", "maps"] as const,
  defaultFieldSchema: ["config", "field-schema"] as const,
  projects: ["projects"] as const,
  projectList: (limit: number) => ["projects", "list", limit] as const,
  project: (id: string) => ["projects", id] as const,
  routes: (id: string) => ["projects", id, "routes"] as const,
  stores: (id: string) => ["projects", id, "stores"] as const,
  storeList: (id: string, filters: StoreFilters) => ["projects", id, "stores", "list", filters] as const,
  pins: (id: string, filters: StoreFilters) => ["projects", id, "stores", "pins", filters] as const,
  store: (id: string, uid: string) => ["projects", id, "stores", "one", uid] as const,
  job: (jobId: string) => ["jobs", jobId] as const,
  jobResult: (jobId: string) => ["jobs", jobId, "result"] as const,
};
