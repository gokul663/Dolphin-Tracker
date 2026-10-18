import { lazy, Suspense, useMemo, useState } from "react";
import { AlertTriangle, Briefcase, CheckCircle2, Clock, MapPin, Plus, Users, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  aggregateTotals,
  applySelection,
  isCompleted,
  sitesByInstaller,
  sitesPerProject,
  statusBreakdown,
} from "@/features/dashboard/aggregate";
import { ProjectCard } from "@/features/dashboard/ProjectCard";
import { ProjectFilter } from "@/features/dashboard/ProjectFilter";
import { ImportWizard } from "@/features/imports/ImportWizard";
import { useAllProjects } from "@/features/projects/api";
import { DeleteProjectDialog, EditProjectDialog } from "@/features/projects/ProjectDialogs";
import type { Project } from "@/lib/api/types";

type TabValue = "all" | "ongoing" | "completed";

function KpiCard({ icon: Icon, label, value, color }: { icon: LucideIcon; label: string; value: number; color: string }) {
  return (
    <Card role="group" aria-label={label} className="flex-row items-center gap-4 p-5 transition-all hover:border-brand/60 hover:shadow-md">
      <div className="rounded-xl p-3" style={{ background: `${color}1A`, color }}>
        <Icon size={22} />
      </div>
      <div>
        <div className="font-mono text-2xl font-bold leading-none">{value}</div>
        <div className="mt-1.5 text-[11px] uppercase tracking-wider text-slate-500">{label}</div>
      </div>
    </Card>
  );
}

// Recharts is the dashboard's largest dependency; it loads after the KPIs and project list render.
const ChartRow = lazy(() => import("@/features/dashboard/charts"));
const CHART_PLACEHOLDERS = (
  <>
    {["Sites by installer", "Status", "Sites per project"].map((label) => (
      <Card key={label} aria-label={`${label} (loading)`} className="h-[300px] animate-pulse bg-slate-50" />
    ))}
  </>
);

export function DashboardPage() {
  const projectsQuery = useAllProjects();
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);
  const [selected, setSelected] = useState<string[] | null>(null);
  const [tab, setTab] = useState<TabValue>("all");
  const [editing, setEditing] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [importing, setImporting] = useState<{ appendTo: Project | null } | null>(null);

  const scoped = useMemo(() => applySelection(projects, selected), [projects, selected]);
  const totals = useMemo(() => aggregateTotals(scoped), [scoped]);
  const ongoing = projects.filter((project) => !isCompleted(project));
  const completed = projects.filter(isCompleted);
  const visible = tab === "ongoing" ? ongoing : tab === "completed" ? completed : projects;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-mono text-xs uppercase tracking-[2px] text-slate-500">Dashboard</h1>
        <Button onClick={() => setImporting({ appendTo: null })} className="font-mono font-semibold uppercase tracking-wider">
          <Plus /> Add new project
        </Button>
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-mono text-xs uppercase tracking-[2px] text-slate-500">Key performance indicators</h2>
          <ProjectFilter projects={projects} selected={selected} onChange={setSelected} />
        </div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          <KpiCard icon={Briefcase} label="Total projects" value={totals.projects} color="#0F5B7C" />
          <KpiCard icon={MapPin} label="Total sites" value={totals.sites} color="#0891b2" />
          <KpiCard icon={Users} label="Total installers" value={totals.installers} color="#7c3aed" />
          <KpiCard icon={CheckCircle2} label="Completed" value={totals.complete} color="#16a34a" />
          <KpiCard icon={Clock} label="Upcoming" value={totals.pending} color="#d97706" />
          <KpiCard icon={AlertTriangle} label="Offline" value={totals.offline} color="#dc2626" />
        </div>
      </section>

      <section className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Suspense fallback={CHART_PLACEHOLDERS}>
          <ChartRow installers={sitesByInstaller(scoped)} statuses={statusBreakdown(totals)} sites={sitesPerProject(scoped)} />
        </Suspense>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-mono text-xs uppercase tracking-[2px] text-slate-500">Projects</h2>
          <Tabs value={tab} onValueChange={(value) => setTab(value as TabValue)}>
            <TabsList>
              <TabsTrigger value="all" className="font-mono text-[11px] uppercase tracking-wider">
                All ({projects.length})
              </TabsTrigger>
              <TabsTrigger value="ongoing" className="font-mono text-[11px] uppercase tracking-wider">
                Ongoing ({ongoing.length})
              </TabsTrigger>
              <TabsTrigger value="completed" className="font-mono text-[11px] uppercase tracking-wider">
                Completed ({completed.length})
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        {projectsQuery.isPending ? (
          <Card className="p-8 text-center font-mono text-slate-500">Loading projects…</Card>
        ) : projectsQuery.isError ? (
          <Card className="items-center gap-3 p-8 text-center font-mono text-rose-700">
            Could not load projects: {projectsQuery.error.message}
            <Button variant="outline" size="sm" onClick={() => projectsQuery.refetch()}>
              Retry
            </Button>
          </Card>
        ) : visible.length === 0 ? (
          <Card className="p-10 text-center font-mono text-slate-500">
            {tab === "completed"
              ? "No completed projects yet."
              : tab === "ongoing"
                ? "No ongoing projects."
                : "No projects yet. Click “Add new project” to begin."}
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
            {visible.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                onAppend={() => setImporting({ appendTo: project })}
                onEdit={() => setEditing(project)}
                onDelete={() => setDeleting(project)}
              />
            ))}
          </div>
        )}
      </section>

      <EditProjectDialog project={editing} onClose={() => setEditing(null)} />
      <DeleteProjectDialog project={deleting} onClose={() => setDeleting(null)} />
      <ImportWizard open={importing !== null} appendTo={importing?.appendTo} onClose={() => setImporting(null)} />
    </div>
  );
}
