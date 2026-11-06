/** One thin, typed function per endpoint (AGENT-HANDOFF §4). Hooks in `the per-feature api.ts modules` wrap these. */
import { api, apiUrl, fetchJson, uploadFile } from "@/lib/api/client";
import type {
  AppendResult,
  AppendStops,
  GeocodeResult,
  HealthResponse,
  ImportJobCreate,
  ImportJobCreated,
  ImportResult,
  Job,
  JobAccepted,
  JobView,
  MapsConfig,
  Page,
  Pin,
  ProgressUpdate,
  ScreensUpdate,
  Project,
  ProjectCreate,
  ProjectCreated,
  ProjectSummary,
  ProjectUpdate,
  ReassignResult,
  RoutesBundle,
  Stop,
  StateCount,
  StoreFieldSpec,
  StoreFilterOptions,
  StopStatus,
  StoreDetailsUpdate,
  Category,
  CategoryInput,
  NameEntry,
  NameListKind,
  NextDay,
  PlanPreview,
  PlanResult,
  PlanStatus,
  PlanStoresAdd,
  PoolFacets,
  PoolStore,
  RoutePlan,
  RoutePlanBundle,
  RoutePlanCreate,
  RoutePlanUpdate,
  Visit,
  VisitInput,
} from "@/lib/api/types";

/** The store list/pins/export/facet query (STORE-MODEL §5). Repeated values OR together; filters AND. */
export interface StoreFilters {
  status?: StopStatus[];
  /** "" selects unassigned stops. */
  installer?: string[];
  pa?: string[];
  state?: string[];
  city?: string[];
  dma?: string[];
  venue_type?: string[];
  /** Any screen's venue id. */
  dd_code?: string[];
  screen_size?: string[];
  /** "In route" / "Not in route" (ROUTE-PLANNER §6). */
  route?: string[];
  /** "Visited" / "Partly visited" / "Not visited", counted since the store's latest plan. */
  visit?: string[];
  q?: string;
  sort?: string;
  dir?: "asc" | "desc";
}

const enc = encodeURIComponent;

function storeQuery(filters: StoreFilters) {
  return {
    status: filters.status,
    installer: filters.installer,
    pa: filters.pa,
    state: filters.state,
    city: filters.city,
    dma: filters.dma,
    venue_type: filters.venue_type,
    dd_code: filters.dd_code,
    screen_size: filters.screen_size,
    route: filters.route,
    visit: filters.visit,
    q: filters.q || undefined,
    sort: filters.sort,
    dir: filters.dir,
  };
}

export const healthApi = {
  get: () => api<HealthResponse>("/health"),
};

export const configApi = {
  maps: () => api<MapsConfig>("/config/maps"),
  storeFields: () => api<StoreFieldSpec[]>("/config/store-fields"),
};

export const placesApi = {
  validate: (address: string) => api<GeocodeResult>("/places/validate", { query: { address } }),
  autocomplete: (q: string) => api<{ suggestions: string[] }>("/places/autocomplete", { query: { q } }),
};

export const projectsApi = {
  list: (params: { limit?: number; cursor?: string | null } = {}) =>
    api<Page<ProjectSummary>>("/projects", { query: { limit: params.limit, cursor: params.cursor } }),
  get: (id: string) => api<ProjectSummary>(`/projects/${enc(id)}`),
  create: (body: ProjectCreate) => api<ProjectCreated>("/projects", { method: "POST", body }),
  update: (id: string, body: ProjectUpdate) => api<Project>(`/projects/${enc(id)}`, { method: "PATCH", body }),
  remove: (id: string, confirm: string) =>
    api<void>(`/projects/${enc(id)}`, { method: "DELETE", query: { confirm } }),
  routes: (id: string) => api<RoutesBundle>(`/projects/${enc(id)}/routes`),
  addInstaller: (id: string, name: string) =>
    api<JobAccepted>(`/projects/${enc(id)}/installers`, { method: "POST", body: { name } }),
  renameInstaller: (id: string, oldName: string, newName: string) =>
    api<Project>(`/projects/${enc(id)}/installers/rename`, {
      method: "POST",
      body: { old_name: oldName, new_name: newName },
    }),
  rebalance: (id: string) => api<JobAccepted>(`/projects/${enc(id)}/routing/rebalance`, { method: "POST" }),
  recluster: (id: string) => api<JobAccepted>(`/projects/${enc(id)}/routing/recluster`, { method: "POST" }),
  reassign: (id: string, uid: string, installer: string) =>
    api<ReassignResult>(`/projects/${enc(id)}/stops/${enc(uid)}/reassign`, { method: "POST", body: { installer } }),
};

export const storesApi = {
  list: (projectId: string, filters: StoreFilters, params: { limit?: number; cursor?: string | null } = {}) =>
    api<Page<Stop>>(`/projects/${enc(projectId)}/stores`, {
      query: { ...storeQuery(filters), limit: params.limit, cursor: params.cursor },
    }),
  pins: (projectId: string, filters: StoreFilters = {}) =>
    api<Pin[]>(`/projects/${enc(projectId)}/stores/pins`, { query: storeQuery(filters) }),
  filters: (projectId: string, filters: StoreFilters) =>
    api<StoreFilterOptions>(`/projects/${enc(projectId)}/stores/filters`, { query: storeQuery(filters) }),
  byState: (projectId: string, filters: StoreFilters, pending = true) =>
    api<StateCount[]>(`/projects/${enc(projectId)}/stores/by-state`, { query: { ...storeQuery(filters), pending } }),
  fieldUsage: (projectId: string) => api<Record<string, number>>(`/projects/${enc(projectId)}/stores/field-usage`),
  /** A plain URL for an <a download> link: the browser streams the CSV itself. */
  exportUrl: (projectId: string, filters: StoreFilters) =>
    apiUrl(`/projects/${enc(projectId)}/stores/export.csv`, storeQuery(filters)),
  get: (projectId: string, uid: string) => api<Stop>(`/projects/${enc(projectId)}/stores/${enc(uid)}`),
  updateDetails: (projectId: string, uid: string, body: StoreDetailsUpdate) =>
    api<Stop>(`/projects/${enc(projectId)}/stores/${enc(uid)}`, { method: "PATCH", body }),
  updateScreens: (projectId: string, uid: string, body: ScreensUpdate) =>
    api<Stop>(`/projects/${enc(projectId)}/stores/${enc(uid)}/screens`, { method: "PUT", body }),
  updateProgress: (projectId: string, uid: string, body: ProgressUpdate) =>
    api<Stop>(`/projects/${enc(projectId)}/stores/${enc(uid)}/progress`, { method: "PATCH", body }),
  append: (projectId: string, body: AppendStops) =>
    api<AppendResult>(`/projects/${enc(projectId)}/stores/append`, { method: "POST", body }),
};

export const jobsApi = {
  createImport: (body: ImportJobCreate) => api<ImportJobCreated>("/jobs/imports", { method: "POST", body }),
  upload: uploadFile,
  start: (jobId: string) => api<Job>(`/jobs/${enc(jobId)}/start`, { method: "POST" }),
  get: (jobId: string) => api<JobView>(`/jobs/${enc(jobId)}`),
  result: (resultUrl: string) => fetchJson<ImportResult>(resultUrl),
  remap: (jobId: string, mapping: Record<string, string>) =>
    api<ImportResult>(`/jobs/${enc(jobId)}/mapping`, { method: "POST", body: { mapping } }),
};

/** The Route Planner's cross-project store picker (ROUTE-PLANNER §4). */
export interface PoolFilters {
  state?: string[];
  city?: string[];
  project_id?: string[];
  status?: StopStatus[];
  pending_only?: boolean;
  available_only?: boolean;
  q?: string;
}

function poolQuery(filters: PoolFilters) {
  return {
    state: filters.state,
    city: filters.city,
    project_id: filters.project_id,
    status: filters.status,
    pending_only: filters.pending_only || undefined,
    available_only: filters.available_only || undefined,
    q: filters.q || undefined,
  };
}

export const storeSearchApi = {
  list: (filters: PoolFilters, params: { limit?: number; cursor?: string | null } = {}) =>
    api<Page<PoolStore>>("/store-search", { query: { ...poolQuery(filters), limit: params.limit, cursor: params.cursor } }),
  pins: (filters: PoolFilters) => api<PoolStore[]>("/store-search/pins", { query: poolQuery(filters) }),
  facets: (filters: PoolFilters) => api<PoolFacets>("/store-search/facets", { query: poolQuery(filters) }),
};

const plan = (id: string) => `/route-plans/${enc(id)}`;

export const routePlansApi = {
  list: (status: PlanStatus, params: { limit?: number; cursor?: string | null } = {}) =>
    api<Page<RoutePlan>>("/route-plans", { query: { status, limit: params.limit, cursor: params.cursor } }),
  get: (id: string) => api<RoutePlanBundle>(plan(id)),
  preview: (body: RoutePlanCreate) => api<PlanPreview>("/route-plans/preview", { method: "POST", body }),
  create: (body: RoutePlanCreate) => api<PlanResult>("/route-plans", { method: "POST", body }),
  update: (id: string, body: RoutePlanUpdate) => api<RoutePlanBundle>(plan(id), { method: "PATCH", body }),
  addStores: (id: string, body: PlanStoresAdd) => api<PlanResult>(`${plan(id)}/stores`, { method: "POST", body }),
  removeStop: (id: string, projectId: string, uid: string) =>
    api<RoutePlanBundle>(`${plan(id)}/stops/${enc(projectId)}/${enc(uid)}`, { method: "DELETE" }),
  reassign: (id: string, projectId: string, uid: string, installer: string, version?: number) =>
    api<RoutePlanBundle>(`${plan(id)}/stops/${enc(projectId)}/${enc(uid)}/reassign`, {
      method: "POST",
      body: { installer, version },
    }),
  nextDay: (id: string, body: NextDay) => api<RoutePlanBundle>(`${plan(id)}/next-day`, { method: "POST", body }),
  close: (id: string) => api<RoutePlanBundle>(`${plan(id)}/close`, { method: "POST" }),
};

export const listsApi = {
  names: (kind: NameListKind) => api<Page<NameEntry>>(`/lists/${kind}`, { query: { limit: 500 } }),
  addName: (kind: NameListKind, value: string) => api<NameEntry>(`/lists/${kind}`, { method: "POST", body: { value } }),
  removeName: (kind: NameListKind, value: string) => api<void>(`/lists/${kind}/${enc(value)}`, { method: "DELETE" }),
  categories: () => api<Category[]>("/lists/categories"),
  saveCategories: (categories: CategoryInput[]) =>
    api<Category[]>("/lists/categories", { method: "PUT", body: { categories } }),
};

export const visitsApi = {
  list: (projectId: string, uid: string, params: { limit?: number; cursor?: string | null } = {}) =>
    api<Page<Visit>>(`/projects/${enc(projectId)}/stores/${enc(uid)}/visits`, {
      query: { limit: params.limit, cursor: params.cursor },
    }),
  create: (projectId: string, uid: string, body: VisitInput) =>
    api<Visit>(`/projects/${enc(projectId)}/stores/${enc(uid)}/visits`, { method: "POST", body }),
};
