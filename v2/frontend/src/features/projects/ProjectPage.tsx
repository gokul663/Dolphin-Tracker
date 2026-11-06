import { ArrowLeft } from "lucide-react";
import { Link, NavLink, Outlet, useOutletContext, useParams } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useProject, useRefreshWhenRoutingFinishes } from "@/features/projects/api";
import { ProjectKpis } from "@/features/projects/ProjectKpis";
import { RoutingBanner } from "@/features/projects/RoutingBanner";
import { ApiError, type Project } from "@/lib/api/types";
import { PROJECT_TYPE_LABELS } from "@/lib/status";
import { cn } from "@/lib/utils";

const TABS = [
  { to: "stores", label: "Stores" },
  { to: "settings", label: "Settings" },
];

/** Tabs read the loaded project from the outlet context instead of refetching it. */
export function useProjectContext(): Project {
  return useOutletContext<{ project: Project }>().project;
}

export function ProjectPage() {
  const { projectId = "" } = useParams();
  const query = useProject(projectId);
  useRefreshWhenRoutingFinishes(query.data);

  if (query.isPending) return <Card className="p-8 text-center font-mono text-slate-500">Loading project…</Card>;
  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <Card className="items-center gap-3 p-8 text-center">
        <p className="font-mono text-rose-700">{notFound ? "This project does not exist." : query.error.message}</p>
        <Button asChild variant="outline" size="sm">
          <Link to="/">Back to dashboard</Link>
        </Button>
      </Card>
    );
  }
  const project = query.data;
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link to="/" className="inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-wider text-slate-500 hover:text-brand">
            <ArrowLeft size={12} /> Dashboard
          </Link>
          <h1 className="truncate font-display text-3xl tracking-[3px]">{project.name}</h1>
          <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-slate-500">
            <Badge variant="outline" className="font-mono text-[10px]">
              {PROJECT_TYPE_LABELS[project.project_type]}
            </Badge>
            <span>PA · {project.pa || "—"}</span>
            <span>· {project.stop_count} stores</span>
            <span>· {project.installers.length} installers</span>
            <span>· {project.stops_per_day} stops/day</span>
          </div>
          <div className="mt-2">
            <ProjectKpis kpi={project.kpi} />
          </div>
        </div>
        <nav aria-label="Project sections" className="flex gap-1 rounded-lg border bg-white p-1">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) =>
                cn(
                  "rounded-md px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider",
                  isActive ? "bg-brand text-white" : "text-slate-600 hover:bg-slate-100",
                )
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </div>
      <RoutingBanner project={project} />
      <Outlet context={{ project }} />
    </section>
  );
}
