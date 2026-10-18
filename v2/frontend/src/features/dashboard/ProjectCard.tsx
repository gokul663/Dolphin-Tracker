import { ArrowRight, CheckCircle2, Loader2, Pencil, Trash2, Upload } from "lucide-react";
import { useNavigate } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { isCompleted, progressPercent } from "@/features/dashboard/aggregate";
import type { ProjectSummary } from "@/lib/api/types";
import { PROJECT_TYPE_LABELS } from "@/lib/status";
import { cn } from "@/lib/utils";

interface Props {
  project: ProjectSummary;
  onAppend: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function Stat({ value, label, tone }: { value: string | number; label: string; tone: string }) {
  return (
    <div className={cn("min-w-0 rounded-lg border p-2 text-center", tone)}>
      <div className="truncate font-mono text-base font-bold" title={String(value)}>
        {value}
      </div>
      <div className="text-[9px] uppercase tracking-wider text-slate-500">{label}</div>
    </div>
  );
}

const pct = (value: number | null) => (value === null ? "—" : `${value}%`);

export function ProjectCard({ project, onAppend, onEdit, onDelete }: Props) {
  const navigate = useNavigate();
  const { kpi } = project;
  const completed = isCompleted(project);
  const percent = progressPercent(project);
  const stop = (handler: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    handler();
  };
  return (
    <Card
      role="link"
      tabIndex={0}
      aria-label={`Open ${project.name}`}
      onClick={() => navigate(`/projects/${project.id}`)}
      onKeyDown={(event) => event.key === "Enter" && navigate(`/projects/${project.id}`)}
      className={cn(
        "group cursor-pointer gap-3 p-5 transition-all hover:border-brand/60 hover:shadow-md",
        completed && "border-emerald-500/40",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-lg font-semibold group-hover:text-brand">{project.name}</span>
            {completed && (
              <Badge variant="outline" className="border-emerald-500/40 bg-emerald-50 font-mono text-[10px] text-emerald-700">
                <CheckCircle2 /> Completed
              </Badge>
            )}
            {project.routing_status === "building" && (
              <Badge variant="outline" className="font-mono text-[10px] text-sky-700">
                <Loader2 className="animate-spin" /> Routing
              </Badge>
            )}
            {project.routing_status === "failed" && (
              <Badge variant="outline" className="border-rose-300 font-mono text-[10px] text-rose-700">
                Routing failed
              </Badge>
            )}
          </div>
          <div className="mt-1 font-mono text-xs text-slate-500">
            <span className="text-slate-400">Type:</span> {PROJECT_TYPE_LABELS[project.project_type]}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            onClick={stop(onAppend)}
            className="inline-flex items-center gap-1.5 rounded border border-brand/25 bg-brand/5 px-2.5 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-brand hover:bg-brand/10"
            aria-label={`Append more CSV/XLSX data to ${project.name}`}
          >
            <Upload size={14} /> Append more
          </button>
          <button
            type="button"
            onClick={stop(onEdit)}
            className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-brand"
            aria-label={`Edit details for ${project.name}`}
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            onClick={stop(onDelete)}
            className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
            aria-label={`Delete ${project.name}`}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {project.installers.map((name) => (
          <Badge key={name} variant="outline" className="bg-slate-50 font-mono text-[10px] text-slate-600">
            {name}
          </Badge>
        ))}
      </div>

      <div className="grid grid-cols-4 gap-2">
        <Stat value={kpi.total} label="Sites" tone="border-slate-200 bg-slate-50 text-brand" />
        <Stat value={kpi.complete} label="Done" tone="border-emerald-200 bg-emerald-50 text-emerald-700" />
        <Stat value={kpi.pending} label="Upcoming" tone="border-amber-200 bg-amber-50 text-amber-700" />
        <Stat value={kpi.offline} label="Offline" tone="border-rose-200 bg-rose-50 text-rose-700" />
      </div>
      <div className="grid grid-cols-3 gap-2 [&_.font-mono]:font-sans [&_.font-mono]:text-xs">
        <Stat value={project.pa || "—"} label="PA" tone="border-violet-200 bg-violet-50 text-violet-700" />
        <Stat value={project.field_agent || "—"} label="Field agent" tone="border-cyan-200 bg-cyan-50 text-cyan-700" />
        <Stat value={project.partner_account || "—"} label="Partner" tone="border-indigo-200 bg-indigo-50 text-indigo-700" />
      </div>
      <div className="grid grid-cols-4 gap-2">
        <Stat value={pct(project.pa_percentage)} label="PA %" tone="border-violet-200 bg-violet-50 text-violet-700" />
        <Stat value={pct(project.dolphin_percentage)} label="Dolphin %" tone="border-sky-200 bg-sky-50 text-brand" />
        <Stat value={pct(project.store_percentage)} label="Store %" tone="border-emerald-200 bg-emerald-50 text-emerald-700" />
        <Stat value={pct(project.fa_percentage)} label="FA %" tone="border-cyan-200 bg-cyan-50 text-cyan-700" />
      </div>

      <div>
        <div className="mb-1 flex justify-between font-mono text-[10px] text-slate-500">
          <span>Progress</span>
          <span>{percent}%</span>
        </div>
        <Progress value={percent} aria-label={`${project.name} progress`} className="h-1.5" />
      </div>
      <div className="flex items-center justify-end font-mono text-xs text-brand">
        Open project <ArrowRight size={14} className="ml-1" />
      </div>
    </Card>
  );
}
