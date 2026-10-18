/** One thin, typed function per endpoint (AGENT-HANDOFF §4). Hooks in `the per-feature api.ts modules` wrap these. */
import { api, apiUrl, fetchJson, uploadFile } from "@/lib/api/client";
import type {
  AppendResult,
  AppendStops,
  FieldDef,
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
  StoreFieldSpec,
  StopStatus,
  StoreDetailsUpdate,
} from "@/lib/api/types";

export interface StoreFilters {
  status?: StopStatus[];
  /** "" selects unassigned stops. */
  installer?: string[];
  q?: string;
  sort?: string;
  dir?: "asc" | "desc";
}

const enc = encodeURIComponent;

function storeQuery(filters: StoreFilters) {
  return {
    status: filters.status,
    installer: filters.installer,
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
  defaultFieldSchema: () => api<FieldDef[]>("/config/field-schema"),
  storeFields: () => api<StoreFieldSpec[]>("/config/store-fields"),
};

export const placesApi = {
  validate: (address: string) => api<GeocodeResult>("/places/validate", { query: { address } }),
  autocomplete: (q: string) => api<{ suggestions: string[] }>("/places/autocomplete", { query: { q } }),
};

export const projectsApi = {
  list: (params: { limit?: number; cursor?: string | null } = {}) =>
    api<Page<ProjectSummary>>("/projects", { query: { limit: params.limit, cursor: params.cursor } }),
  get: (id: string) => api<Project>(`/projects/${enc(id)}`),
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
};
