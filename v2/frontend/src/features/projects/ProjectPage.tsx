import { useCan } from "@/lib/auth/me";
import { useState } from "react";
import { ArrowLeft, Loader2, Settings } from "lucide-react";
import {
  Link,
  NavLink,
  Outlet,
  useMatch,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router";
import { useStoresUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  useProject,
  useRefreshWhenRoutingFinishes,
} from "@/features/projects/api";
import { COMPLETED_BUCKETS, ProjectKpis } from "@/features/projects/ProjectKpis";
import { useAutoDeviceSync } from "@/features/device/api";
import { DeviceBadge } from "@/features/device/DeviceBits";
import { ReviewDialog } from "@/features/device/ReviewDialog";
import { ApiError, type Project } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const NO_BUCKETS: string[] = [];

/** The list, by store or by screen: one switch for the table, the map and the chart. */
const VIEWS = [
  { unit: "locations", label: "Stores" },
  { unit: "screens", label: "Screens" },
] as const;
const tabClass = (active: boolean) =>
  cn("rounded-md px-3 py-1.5 font-mono text-xs uppercase tracking-wider", active ? "bg-brand text-white" : "text-slate-600 hover:bg-slate-100");

/** Tabs read the loaded project from the outlet context instead of refetching it. */
export function useProjectContext(): Project {
  return useOutletContext<{ project: Project }>().project;
}

/** Open "Needs review" from a tab, narrowed to a search (the Stores search found records waiting there). */
export function useOpenDeviceReview(): (search?: string) => void {
  return useOutletContext<{ openReview?: (search?: string) => void } | null>()?.openReview ?? (() => {});
}

export function ProjectPage() {
  const { projectId = "" } = useParams();
  const query = useProject(projectId);
  const navigate = useNavigate();
  useRefreshWhenRoutingFinishes(query.data);
  const canEdit = useCan("projects.edit");
  const autoSync = useAutoDeviceSync(query.data);
  const [reviewing, setReviewing] = useState(false);
  const [reviewSearch, setReviewSearch] = useState("");
  const openReview = (search = "") => {
    setReviewSearch(search);
    setReviewing(true);
  };
  const onList = useMatch("/projects/:projectId/stores") !== null;
  const unit = useStoresUi((state) => (state.projectId === projectId ? state.unit : "locations"));
  const activeBuckets = useStoresUi((state) => (state.projectId === projectId ? state.facets.bucket : NO_BUCKETS));

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
  // Done stores with fewer screen rows than committed: the "Screens done" filter's "Needs review".
  const showMissingScreens = () => {
    useStoresUi.getState().enterProject(project.id);
    const ui = useStoresUi.getState();
    if (!ui.facets.fulfilled.includes("Needs review")) ui.toggleFacet("fulfilled", "Needs review");
    setReviewing(false);
    navigate("stores");
  };
  // A store named in Needs review (a screen of another PA at its address): its drawer on the Stores tab.
  const openStore = (uid: string) => {
    useStoresUi.getState().enterProject(project.id);
    useStoresUi.getState().select(uid, true);
    setReviewing(false);
    navigate("stores");
  };
  return (
    <section className="space-y-4">
      {/* One row, as in v1: back + name, the KPI strip, then the sections. */}
      <div className="flex flex-wrap items-stretch gap-3">
        {/* Breadcrumb on top, the project's name as the main part, its PA under it; centred. */}
        <div className="flex min-w-[9rem] flex-col items-center justify-center gap-0.5 rounded-xl border bg-white px-4 py-2 text-center shadow-sm">
          <nav aria-label="Breadcrumb">
            <Link
              to="/"
              className="inline-flex items-center gap-1 font-mono text-xs uppercase tracking-wider text-slate-500 hover:text-brand hover:underline"
            >
              <ArrowLeft size={12} /> Projects
            </Link>
          </nav>
          <h1 className="min-w-0 max-w-full truncate font-display text-3xl leading-tight tracking-[3px]">{project.name}</h1>
          {project.pa && (
            <p className="font-mono text-xs text-slate-500" aria-label="Project PA">
              PA · <span className="font-medium text-slate-700">{project.pa}</span>
            </p>
          )}
        </div>
        <div className="flex min-w-0 flex-1">
          <ProjectKpis
            kpi={project.kpi}
            reviewCount={project.device_sync?.review_count ?? 0}
            otherPaCount={project.device_sync?.other_pa_count ?? 0}
            onDeviceReview={() => openReview()}
            activeBuckets={activeBuckets}
            onBucket={(bucket) => {
              useStoresUi.getState().enterProject(project.id);
              useStoresUi.getState().toggleFacet("bucket", bucket);
              navigate("stores");
            }}
            onCompleted={() => {
              const ui = useStoresUi.getState();
              ui.enterProject(project.id);
              const on = useStoresUi.getState().facets.bucket;
              const both = COMPLETED_BUCKETS.every((bucket) => on.includes(bucket));
              // Both on: take both off. Otherwise switch on whichever is missing.
              for (const bucket of COMPLETED_BUCKETS) if (both || !on.includes(bucket)) ui.toggleFacet("bucket", bucket);
              navigate("stores");
            }}
            onNeedsAttention={() => {
              useStoresUi.getState().enterProject(project.id);
              useStoresUi.getState().setNeedsAttention(true);
              navigate("stores");
            }}
          />
        </div>
        {/* One column width: the tabs and the CMS data pill line up edge to edge. */}
        <div className="flex flex-col items-stretch justify-center gap-1.5">
          <nav
            aria-label="Project sections"
            className="flex justify-center gap-1 rounded-lg border bg-white p-1"
          >
            {VIEWS.map((view) => (
              <button
                key={view.unit}
                type="button"
                aria-current={onList && unit === view.unit ? "page" : undefined}
                className={tabClass(onList && unit === view.unit)}
                onClick={() => {
                  useStoresUi.getState().enterProject(project.id);
                  useStoresUi.getState().setUnit(view.unit);
                  navigate("stores");
                }}
              >
                {view.label}
              </button>
            ))}
            {canEdit && (
              <NavLink to="settings" aria-label="Settings" title="Settings" className={({ isActive }) => cn(tabClass(isActive), "flex items-center px-2")}>
                <Settings size={15} />
              </NavLink>
            )}
          </nav>
          {/* Under the tabs: when the CMS data was last synced. */}
          {autoSync.isPending ? (
            <span className="flex items-center gap-1 font-mono text-xs text-cyan-800">
              <Loader2 className="size-3 animate-spin" /> Syncing CMS data
            </span>
          ) : (
            project.device_sync && <DeviceBadge date={project.device_sync.snapshot_date} className="w-full justify-center py-1" />
          )}
        </div>
      </div>
      <Outlet context={{ project, openReview }} />
      {project.device_sync && <ReviewDialog project={project} open={reviewing} search={reviewSearch} onClose={() => setReviewing(false)} onMissingScreens={showMissingScreens} onOpenStore={openStore} />}
    </section>
  );
}
