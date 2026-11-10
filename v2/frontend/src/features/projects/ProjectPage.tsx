import { useState } from "react";
import { ArrowLeft, Inbox, Loader2 } from "lucide-react";
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
import { useAutoDeviceSync } from "@/features/device/api";
import { DeviceBadge } from "@/features/device/DeviceBits";
import { ReviewDialog } from "@/features/device/ReviewDialog";
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
  const autoSync = useAutoDeviceSync(query.data);
  const [reviewing, setReviewing] = useState(false);

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
        {project.device_sync && project.device_sync.review_count > 0 && (
          <button
            type="button"
            onClick={() => setReviewing(true)}
            className="flex flex-col items-center justify-center rounded-xl border border-cyan-300 bg-cyan-50 px-3 py-2 text-center text-cyan-900 shadow-sm hover:bg-cyan-100"
            aria-label={`${project.device_sync.review_count} screens in the Dolphin data need review`}
            title="Screens the CMS reports for this PA that are in no store here: add them or set them aside"
          >
            <span className="flex items-center gap-1 text-2xl font-semibold leading-tight tabular-nums">
              <Inbox className="size-5" /> {project.device_sync.review_count.toLocaleString()}
            </span>
            <span className="max-w-[10ch] text-balance font-mono text-[10px] uppercase leading-tight tracking-wider">Needs review</span>
          </button>
        )}
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
        {/* One column width: the tabs, the type/PA line and the Dolphin data pill line up edge to edge. */}
        <div className="flex flex-col items-stretch justify-center gap-1.5">
          <nav
            aria-label="Project sections"
            className="flex justify-center gap-1 rounded-lg border bg-white p-1"
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
          {/* Its own line, under the type and PA. */}
          {autoSync.isPending ? (
            <span className="flex items-center gap-1 font-mono text-[10px] text-cyan-800">
              <Loader2 className="size-3 animate-spin" /> Syncing Dolphin data
            </span>
          ) : (
            project.device_sync && <DeviceBadge date={project.device_sync.snapshot_date} className="w-full justify-center py-1" />
          )}
        </div>
      </div>
      <Outlet context={{ project }} />
      {project.device_sync && <ReviewDialog project={project} open={reviewing} onClose={() => setReviewing(false)} />}
    </section>
  );
}
