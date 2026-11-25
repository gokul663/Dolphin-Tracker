/** One thin, typed function per endpoint (AGENT-HANDOFF §4). Hooks in `the per-feature api.ts modules` wrap these. */
import { api, apiUrl, fetchJson, uploadFile } from "@/lib/api/client";
import type {
  AppendResult,
  AppendStops,
  StoreAdd,
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
  HardwareCounts,
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
  VisitInput, OverwriteField, ReviewAdd, OverwriteResult, PaList, ReviewItem, ReviewPage, LogPage, UploadList, SyncResult, PopulateResult, DayInsert, DayLockSet, StopMove, StopMark, InsertOptions, InsertQuery, StorePage, ScreenPage, PlaceHit, InstallerSave, InstallerSaved, InstallerWorkReport, ScreenSheetResult } from "@/lib/api/types";
import type { StorePageParams } from "@/lib/api/keys";
import type { StatusBucket } from "@/lib/status";

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
  /** The store's status group (Completed, Upcoming, In Progress, Offline, Cancelled). */
  bucket?: StatusBucket[];
  /** Technician / Self install / Rep install. */
  install_type?: string[];
  /** The store's technician; "" selects stores without one. */
  technician?: string[];
  /** "Needs mount" / "No mount needed". */
  mount?: string[];
  /** "Fulfilled" / "Not fulfilled" / "No commitment": Completed screens against the committed counts. */
  fulfilled?: string[];
  /** "Has review notes" / "No review notes": what the import's review step (or someone since) left to check. */
  review?: string[];
  /** Only stores added without a name or a verified address (not fixed yet). */
  needs_attention?: boolean;
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
    bucket: filters.bucket,
    install_type: filters.install_type,
    technician: filters.technician,
    mount: filters.mount,
    fulfilled: filters.fulfilled,
    review: filters.review,
    needs_attention: filters.needs_attention || undefined,
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
  /** `name` (the store's) lets Google place the business itself, as Google Search does. */
  validate: (address: string, name = "") =>
    api<GeocodeResult>("/places/validate", { query: { address, ...(name.trim() ? { name: name.trim() } : {}) } }),
  autocomplete: (q: string) => api<{ suggestions: string[] }>("/places/autocomplete", { query: { q } }),
  /** What Google Search lists for a store: the store by name at its address, then the places at that address. */
  search: (address: string, name = "") =>
    api<PlaceHit[]>("/places/search", { query: { address, ...(name.trim() ? { name: name.trim() } : {}) } }),
};

export const projectsApi = {
  list: (params: { limit?: number; cursor?: string | null } = {}) =>
    api<Page<ProjectSummary>>("/projects", { query: { limit: params.limit, cursor: params.cursor } }),
  get: (id: string) => api<ProjectSummary>(`/projects/${enc(id)}`),
  create: (body: ProjectCreate) => api<ProjectCreated>("/projects", { method: "POST", body }),
  /** Every sheet imported into the project (kept for good), newest first, each with a download link. */
  uploads: (id: string) => api<UploadList>(`/projects/${enc(id)}/uploads`),
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
  /** Admins only: the store, its screens and its visits, for good. 409 while it is in a route plan. */
  remove: (projectId: string, uid: string) =>
    api<void>(`/projects/${enc(projectId)}/stores/${enc(uid)}`, { method: "DELETE" }),
  list: (projectId: string, filters: StoreFilters, page: StorePageParams) =>
    api<StorePage>(`/projects/${enc(projectId)}/stores`, {
      query: { ...storeQuery(filters), limit: page.limit, offset: page.offset, ...(page.bounds ?? {}) },
    }),
  /** One row per screen, under the same filters; status, DD code and size keep the screens they match. */
  screens: (projectId: string, filters: StoreFilters, page: StorePageParams) =>
    api<ScreenPage>(`/projects/${enc(projectId)}/stores/screens`, {
      query: { ...storeQuery(filters), limit: page.limit, offset: page.offset, ...(page.bounds ?? {}) },
    }),
  pins: (projectId: string, filters: StoreFilters = {}) =>
    api<Pin[]>(`/projects/${enc(projectId)}/stores/pins`, { query: storeQuery(filters) }),
  filters: (projectId: string, filters: StoreFilters) =>
    api<StoreFilterOptions>(`/projects/${enc(projectId)}/stores/filters`, { query: storeQuery(filters) }),
  byState: (projectId: string, filters: StoreFilters, pending = true, unit: "stores" | "screens" = "stores") =>
    api<StateCount[]>(`/projects/${enc(projectId)}/stores/by-state`, {
      query: { ...storeQuery(filters), pending, unit, limit: 60 }, // every state: the chart grows a row per state
    }),
  /** Installed hardware (sticks, Dolphin TVs by size) of the stores the filters keep. */
  hardware: (projectId: string, filters: StoreFilters) =>
    api<HardwareCounts>(`/projects/${enc(projectId)}/stores/hardware`, { query: storeQuery(filters) }),
  fieldUsage: (projectId: string) => api<Record<string, number>>(`/projects/${enc(projectId)}/stores/field-usage`),
  /** A plain URL for an <a download> link: the browser streams the CSV itself. */
  exportUrl: (projectId: string, filters: StoreFilters) =>
    apiUrl(`/projects/${enc(projectId)}/stores/export.csv`, storeQuery(filters)),
  get: (projectId: string, uid: string) => api<Stop>(`/projects/${enc(projectId)}/stores/${enc(uid)}`),
  updateDetails: (projectId: string, uid: string, body: StoreDetailsUpdate) =>
    api<Stop>(`/projects/${enc(projectId)}/stores/${enc(uid)}`, { method: "PATCH", body }),
  updateScreens: (projectId: string, uid: string, body: ScreensUpdate) =>
    api<Stop>(`/projects/${enc(projectId)}/stores/${enc(uid)}/screens`, { method: "PUT", body }),
  setExternalId: (projectId: string, uid: string, externalId: string) =>
    api<Stop>(`/projects/${enc(projectId)}/stores/${enc(uid)}/external-id`, { method: "PUT", body: { external_id: externalId } }),
  updateProgress: (projectId: string, uid: string, body: ProgressUpdate) =>
    api<Stop>(`/projects/${enc(projectId)}/stores/${enc(uid)}/progress`, { method: "PATCH", body }),
  add: (projectId: string, body: StoreAdd) => api<Stop>(`/projects/${enc(projectId)}/stores`, { method: "POST", body }),
  append: (projectId: string, body: AppendStops) =>
    api<AppendResult>(`/projects/${enc(projectId)}/stores/append`, { method: "POST", body }),
};

/** A screen cost sheet (DD code, size, screen count, cost) against the project's screens: a preview, or with
 *  `apply` the sizes and owners written. */
export const screenSheetApi = {
  send: (projectId: string, body: { filename: string; content_base64: string; apply: boolean }) =>
    api<ScreenSheetResult>(`/projects/${enc(projectId)}/screen-sheet`, { method: "POST", body }),
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
  dma?: string[];
  pa?: string[];
  bucket?: string[];
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
    dma: filters.dma,
    pa: filters.pa,
    bucket: filters.bucket,
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
  /** Starts a background refresh of every Dolphin venue (all PAs); it takes a minute or two. */
  refreshVenues: () => api<{ started: boolean }>("/store-search/venues/refresh", { method: "POST" }),
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
  setDayLock: (id: string, body: DayLockSet) => api<RoutePlanBundle>(`${plan(id)}/days/lock`, { method: "POST", body }),
  insertOptions: (id: string, body: InsertQuery) =>
    api<InsertOptions>(`${plan(id)}/days/insert-options`, { method: "POST", body }),
  insert: (id: string, body: DayInsert) => api<RoutePlanBundle>(`${plan(id)}/days/insert`, { method: "POST", body }),
  moveToNextDay: (id: string, projectId: string, uid: string, version?: number) =>
    api<RoutePlanBundle>(`${plan(id)}/stops/${enc(projectId)}/${enc(uid)}/next-day`, { method: "POST", body: { version } }),
  /** Put a store on a chosen installer's day (pinned there), or move it to another plan (`to_plan_id`). */
  move: (id: string, projectId: string, uid: string, body: StopMove) =>
    api<RoutePlanBundle>(`${plan(id)}/stops/${enc(projectId)}/${enc(uid)}/move`, { method: "POST", body }),
  /** Mark a stop Done / Incomplete / in route, or release its pin. */
  mark: (id: string, projectId: string, uid: string, body: StopMark) =>
    api<RoutePlanBundle>(`${plan(id)}/stops/${enc(projectId)}/${enc(uid)}/mark`, { method: "POST", body }),
  /** Take a store off its day and keep it with the plan (shown as removed) for a manager to decide on. */
  setAside: (id: string, projectId: string, uid: string) =>
    api<RoutePlanBundle>(`${plan(id)}/stops/${enc(projectId)}/${enc(uid)}/set-aside`, { method: "POST" }),
  /** Put a set-aside store back on a day. */
  restore: (id: string, projectId: string, uid: string, body: StopMove) =>
    api<RoutePlanBundle>(`${plan(id)}/stops/${enc(projectId)}/${enc(uid)}/restore`, { method: "POST", body }),
  close: (id: string) => api<RoutePlanBundle>(`${plan(id)}/close`, { method: "POST" }),
};

export const listsApi = {
  names: (kind: NameListKind) => api<Page<NameEntry>>(`/lists/${kind}`, { query: { limit: 500 } }),
  addName: (kind: NameListKind, value: string) => api<NameEntry>(`/lists/${kind}`, { method: "POST", body: { value } }),
  removeName: (kind: NameListKind, value: string) => api<void>(`/lists/${kind}/${enc(value)}`, { method: "DELETE" }),
  /** Add an installer or change their details (name, phone, email, shipping address). */
  saveInstaller: (name: string, body: Partial<InstallerSave>) => api<InstallerSaved>(`/lists/installers/${enc(name)}`, { method: "PUT", body }),
  /** Per installer across every project: stores and screens; and the names on stores that match no installer. */
  installerWork: () => api<InstallerWorkReport>("/lists/installers/work"),
  /** Stores whose technician matches an installer in another case take the list's spelling. */
  syncInstallers: () => api<{ stores_updated: number }>("/lists/installers/sync", { method: "POST" }),
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

/** The CMS device report (MongoDB, read through the device-data Lambda) and each project's sync with it. */
export const deviceSyncApi = {
  pas: () => api<PaList>("/device-data/pas"),
  sync: (projectId: string, onlyIfStale = false) =>
    api<SyncResult>(`/projects/${enc(projectId)}/device-sync`, {
      method: "POST",
      query: onlyIfStale ? { only_if_stale: true } : {},
    }),
  /** Add a store for every record of the project's PA that no store has, then sync (a project with no sheet). */
  populate: (projectId: string) =>
    api<PopulateResult>(`/projects/${enc(projectId)}/device-sync/populate`, { method: "POST" }),
  review: (projectId: string, params: { limit: number; cursor?: string | null; includeSnoozed?: boolean; q?: string }) =>
    api<ReviewPage>(`/projects/${enc(projectId)}/device-sync/review`, {
      query: {
        limit: params.limit, cursor: params.cursor ?? undefined, include_snoozed: params.includeSnoozed || undefined,
        q: params.q?.trim() || undefined,
      },
    }),
  add: (projectId: string, key: string, body: Partial<ReviewAdd> = {}) =>
    api<Stop>(`/projects/${enc(projectId)}/device-sync/review/${enc(key)}/add`, { method: "POST", body }),
  snooze: (projectId: string, key: string) =>
    api<ReviewItem>(`/projects/${enc(projectId)}/device-sync/review/${enc(key)}/snooze`, { method: "POST" }),
  overwriteAll: (projectId: string, fields: OverwriteField[]) =>
    api<OverwriteResult>(`/projects/${enc(projectId)}/device-sync/overwrite`, { method: "POST", body: { fields } }),
  overwriteStore: (projectId: string, uid: string, fields: OverwriteField[]) =>
    api<OverwriteResult>(`/projects/${enc(projectId)}/stores/${enc(uid)}/device-overwrite`, { method: "POST", body: { fields } }),
  logs: (projectId: string, uid: string, params: { ddCode?: string; limit: number; cursor?: string | null }) =>
    api<LogPage>(`/projects/${enc(projectId)}/stores/${enc(uid)}/device-logs`, {
      query: { dd_code: params.ddCode || undefined, limit: params.limit, cursor: params.cursor ?? undefined },
    }),
  ignoreAlert: (projectId: string, uid: string) =>
    api<Stop>(`/projects/${enc(projectId)}/stores/${enc(uid)}/device-alert/ignore`, { method: "POST" }),
};
