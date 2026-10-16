import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useRoutingJob } from "@/features/projects/api";
import type { Project } from "@/lib/api/types";

/** Shown while a routing job runs (the project query polls) or after one failed. */
export function RoutingBanner({ project }: { project: Project }) {
  const job = useRoutingJob(project.id);
  if (project.routing_status === "building") {
    return (
      <div role="status" className="flex items-center gap-3 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
        <Loader2 className="size-4 animate-spin" />
        <span>
          <strong>Routing in progress.</strong> Stores stay viewable and editable; routes update when the build finishes.
        </span>
      </div>
    );
  }
  if (project.routing_status === "failed") {
    const retry = async () => {
      try {
        await job.mutateAsync({ kind: "recluster" });
        toast.success("Routing restarted");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not restart routing");
      }
    };
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
        <AlertTriangle className="size-4" />
        <span className="flex-1">
          <strong>The last routing build failed.</strong> Stores are safe; rebuild the routes to try again.
        </span>
        <Button size="sm" variant="outline" onClick={retry} disabled={job.isPending}>
          {job.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Rebuild routes
        </Button>
      </div>
    );
  }
  return null;
}
