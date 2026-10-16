import { useMemo, useState } from "react";
import { Check, Search, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { searchProjects, toggleSelection } from "@/features/dashboard/aggregate";
import type { ProjectSummary } from "@/lib/api/types";
import { cn } from "@/lib/utils";

interface Props {
  projects: ProjectSummary[];
  selected: string[] | null;
  onChange: (selected: string[] | null) => void;
}

/** v1 "KPI project filter": choose which projects the KPI cards and charts aggregate. */
export function ProjectFilter({ projects, selected, onChange }: Props) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => searchProjects(projects, query), [projects, query]);
  const allIds = projects.map((project) => project.id);
  const label =
    selected === null ? "All projects" : `${selected.length} project${selected.length === 1 ? "" : "s"}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="font-mono text-xs">
          <SlidersHorizontal /> {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="border-b p-3">
          <div className="mb-2 font-mono text-xs uppercase tracking-wider text-slate-500">KPI project filter</div>
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, PA, or project type…"
              className="pl-9"
              aria-label="Search projects"
            />
          </div>
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={() => onChange(visible.map((project) => project.id))} disabled={!visible.length}>
              Select visible ({visible.length})
            </Button>
            <Button size="sm" variant="outline" onClick={() => onChange(null)}>
              All projects
            </Button>
            <Button size="sm" variant="outline" onClick={() => onChange([])}>
              Clear
            </Button>
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {visible.length === 0 ? (
            <div className="p-6 text-center text-sm text-slate-500">No matching projects</div>
          ) : (
            visible.map((project) => {
              const checked = selected === null || selected.includes(project.id);
              return (
                <button
                  type="button"
                  key={project.id}
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  onClick={() => onChange(toggleSelection(selected, allIds, project.id))}
                  className="flex w-full items-start gap-3 rounded-md px-3 py-2 text-left hover:bg-slate-100"
                >
                  <span
                    className={cn(
                      "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
                      checked ? "border-brand bg-brand text-white" : "border-slate-300 bg-white",
                    )}
                  >
                    {checked && <Check size={12} />}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-slate-800">{project.name}</span>
                    <span className="block truncate font-mono text-[10px] text-slate-500">
                      {project.pa ? `PA · ${project.pa}` : "No PA"}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
