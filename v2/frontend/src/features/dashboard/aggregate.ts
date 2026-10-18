import { STOP_STATUSES, type ProjectSummary, type ScreenStatus } from "@/lib/api/types";
import { PROJECT_TYPE_LABELS } from "@/lib/status";

export interface DashboardTotals {
  projects: number;
  sites: number;
  installers: number;
  complete: number;
  pending: number;
  offline: number;
  other: number;
  /** Stores by derived status, all eight (STORE-MODEL §5). */
  byStatus: Record<ScreenStatus, number>;
  screens: ScreenTotals;
}

/** Screens across the selected projects: rows, and committed (sheet) vs actual (rows) per kind. */
export interface ScreenTotals {
  total: number;
  committedDolphin: number;
  actualDolphin: number;
  committedTvs: number;
  actualTvs: number;
}

export function screenTotals(kpis: Pick<ProjectSummary["kpi"], "screens_total" | "committed_dolphin_screens" | "actual_dolphin_screens" | "committed_store_tvs" | "actual_store_tvs">[]): ScreenTotals {
  const totals: ScreenTotals = { total: 0, committedDolphin: 0, actualDolphin: 0, committedTvs: 0, actualTvs: 0 };
  for (const kpi of kpis) {
    totals.total += kpi.screens_total;
    totals.committedDolphin += kpi.committed_dolphin_screens;
    totals.actualDolphin += kpi.actual_dolphin_screens;
    totals.committedTvs += kpi.committed_store_tvs;
    totals.actualTvs += kpi.actual_store_tvs;
  }
  return totals;
}

const zeroStatuses = () => Object.fromEntries(STOP_STATUSES.map((status) => [status, 0])) as Record<ScreenStatus, number>;

/** v1 Dashboard `filteredKpi`: totals across the selected projects; installers counted once by name. */
export function aggregateTotals(projects: ProjectSummary[]): DashboardTotals {
  const installers = new Set<string>();
  const totals: DashboardTotals = {
    projects: projects.length, sites: 0, installers: 0, complete: 0, pending: 0, offline: 0, other: 0, byStatus: zeroStatuses(),
    screens: screenTotals(projects.map((project) => project.kpi)),
  };
  for (const project of projects) {
    project.installers.forEach((name) => installers.add(name));
    totals.sites += project.kpi.total;
    totals.complete += project.kpi.complete;
    totals.pending += project.kpi.pending;
    totals.offline += project.kpi.offline;
    totals.other += project.kpi.other;
    for (const status of STOP_STATUSES) totals.byStatus[status] += project.kpi.by_status[status] ?? 0;
  }
  totals.installers = installers.size;
  return totals;
}

export function sitesByInstaller(projects: ProjectSummary[]): { name: string; value: number }[] {
  const totals = new Map<string, number>();
  for (const project of projects) {
    for (const [name, count] of Object.entries(project.kpi.by_installer)) totals.set(name, (totals.get(name) ?? 0) + count);
  }
  return [...totals].map(([name, value]) => ({ name, value }));
}

export function statusBreakdown(totals: DashboardTotals) {
  return STOP_STATUSES.map((status) => ({ status, value: totals.byStatus[status] })).filter((entry) => entry.value > 0);
}

export function sitesPerProject(projects: ProjectSummary[]) {
  return projects.map((project) => ({
    name: project.name.length > 18 ? `${project.name.slice(0, 16)}…` : project.name,
    sites: project.kpi.total,
  }));
}

/** v1: a project is completed once it has sites and nothing pending or offline (v1's "technical issue"). */
export function isCompleted(project: ProjectSummary): boolean {
  return project.kpi.total > 0 && project.kpi.pending === 0 && project.kpi.offline === 0;
}

export function progressPercent(project: ProjectSummary): number {
  return project.kpi.total ? Math.round((project.kpi.complete / project.kpi.total) * 100) : 0;
}

export function searchProjects(projects: ProjectSummary[], query: string): ProjectSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return projects;
  return projects.filter((project) =>
    [project.name, project.pa, PROJECT_TYPE_LABELS[project.project_type] ?? project.project_type]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}

/** KPI project filter: `null` means "all projects". Toggling from "all" starts from every id. */
export function toggleSelection(selected: string[] | null, allIds: string[], id: string): string[] {
  const current = selected ?? allIds;
  return current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
}

export function applySelection(projects: ProjectSummary[], selected: string[] | null): ProjectSummary[] {
  return selected === null ? projects : projects.filter((project) => selected.includes(project.id));
}
