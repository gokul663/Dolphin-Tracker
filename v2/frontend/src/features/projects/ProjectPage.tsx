import { ArrowLeft } from "lucide-react";
import {
  Link,
  NavLink,
  Outlet,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router";
import { useStoresUi } from "@/stores/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  useProject,
  useRefreshWhenRoutingFinishes,
} from "@/features/projects/api";
import { ProjectKpis } from "@/features/projects/ProjectKpis";
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
  const navigate = useNavigate();
  useRefreshWhenRoutingFinishes(query.data);

  if (query.isPending)
    return (
      <Card className="p-8 text-center font-mono text-slate-500">
        Loading project…
      </Card>
    );
  if (query.isError) {
    const notFound =
      query.error instanceof ApiError && query.error.status === 404;
    return (
      <Card className="items-center gap-3 p-8 text-center">
        <p className="font-mono text-rose-700">
          {notFound ? "This project does not exist." : query.error.message}
        </p>
        <Button asChild variant="outline" size="sm">
          <Link to="/">Back to dashboard</Link>
        </Button>
      </Card>
    );
  }
  const project = query.data;
  return (
    <section className="space-y-4">
      {/* One row, as in v1: back + name, the KPI strip, then the sections. */}
      <div className="flex flex-wrap items-stretch gap-3">
        <div className="flex min-w-0 items-center gap-3 rounded-xl border bg-white px-3 py-2 shadow-sm">
          <Link
            to="/"
            className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-slate-600 hover:bg-slate-50 hover:text-brand"
          >
            <ArrowLeft size={12} /> Projects
          </Link>
          <h1 className="min-w-0 truncate border-l pl-3 font-display text-2xl leading-tight tracking-[3px]">
            {project.name}
          </h1>
        </div>
        <div className="flex min-w-0 flex-1">
          <ProjectKpis
            kpi={project.kpi}
            onNeedsAttention={() => {
              useStoresUi.getState().enterProject(project.id);
              useStoresUi.getState().setNeedsAttention(true);
              navigate("stores");
            }}
          />
        </div>
        <div className="flex flex-col items-end justify-center gap-1.5">
          <nav
            aria-label="Project sections"
            className="flex gap-1 rounded-lg border bg-white p-1"
          >
            {TABS.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                className={({ isActive }) =>
                  cn(
                    "rounded-md px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider",
                    isActive
                      ? "bg-brand text-white"
                      : "text-slate-600 hover:bg-slate-100",
                  )
                }
              >
                {tab.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex flex-wrap items-center justify-end gap-1.5 font-mono text-[10px] text-slate-500">
            <Badge
              variant="outline"
              className="px-1.5 py-0 font-mono text-[9px]"
            >
              {PROJECT_TYPE_LABELS[project.project_type]}
            </Badge>
            <span>PA · {project.pa || "—"}</span>
          </div>
        </div>
      </div>
      <Outlet context={{ project }} />
    </section>
  );
}
