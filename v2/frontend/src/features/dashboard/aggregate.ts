import type { ProjectSummary } from "@/lib/api/types";
import { PROJECT_TYPE_LABELS } from "@/lib/status";

export interface DashboardTotals {
  projects: number;
  sites: number;
  installers: number;
  complete: number;
  pending: number;
  technical: number;
  other: number;
}

/** v1 Dashboard `filteredKpi`: totals across the selected projects; installers counted once by name. */
export function aggregateTotals(projects: ProjectSummary[]): DashboardTotals {
  const installers = new Set<string>();
  const totals: DashboardTotals = { projects: projects.length, sites: 0, installers: 0, complete: 0, pending: 0, technical: 0, other: 0 };
  for (const project of projects) {
    project.installers.forEach((name) => installers.add(name));
    totals.sites += project.kpi.total;
    totals.complete += project.kpi.complete;
    totals.pending += project.kpi.pending;
    totals.technical += project.kpi.technical;
    totals.other += project.kpi.other;
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
  return [
    { status: "Complete" as const, value: totals.complete },
    { status: "Incomplete" as const, value: totals.pending },
    { status: "Technical Issue" as const, value: totals.technical },
    { status: "Other" as const, value: totals.other },
  ].filter((entry) => entry.value > 0);
}

export function sitesPerProject(projects: ProjectSummary[]) {
  return projects.map((project) => ({
    name: project.name.length > 18 ? `${project.name.slice(0, 16)}…` : project.name,
    sites: project.kpi.total,
  }));
}

/** v1: a project is completed once it has sites and nothing pending or with a technical issue. */
export function isCompleted(project: ProjectSummary): boolean {
  return project.kpi.total > 0 && project.kpi.pending === 0 && project.kpi.technical === 0;
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
