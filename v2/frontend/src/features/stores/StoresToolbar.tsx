import { useEffect, useState } from "react";
import { ChevronDown, Download, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { storeExportUrl } from "@/features/stores/api";
import type { StoreFilters } from "@/lib/api/resources";
import { STOP_STATUSES, type Project } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";
import { useStoresUi } from "@/stores/ui";
import { cn } from "@/lib/utils";

const UNASSIGNED = "";

/** Search, status and installer filters, "only in view", CSV export of the current view. */
export function StoresToolbar({ project, filters }: { project: Project; filters: StoreFilters }) {
  const ui = useStoresUi();
  const [draft, setDraft] = useState(ui.search);
  useEffect(() => setDraft(ui.search), [ui.search]);
  useEffect(() => {
    const timer = window.setTimeout(() => draft !== ui.search && ui.setSearch(draft), 250);
    return () => window.clearTimeout(timer);
  }, [draft]); // only the draft drives the debounce; `ui` is the stable store
  const active = ui.search || ui.status.length || ui.installer.length || ui.onlyInView;
  const installerLabel =
    ui.installer.length === 0 ? "All installers" : ui.installer.map((name) => name || "Unassigned").join(", ");

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-56 flex-1">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <Input
          aria-label="Search stores"
          placeholder="Search name, address, ZIP, fields, comment…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="pl-9"
        />
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Status filter">
        {STOP_STATUSES.map((status) => {
          const on = ui.status.includes(status);
          return (
            <button
              key={status}
              type="button"
              aria-pressed={on}
              onClick={() => ui.toggleStatus(status)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider",
                on ? "border-slate-800 bg-slate-800 text-white" : "bg-white text-slate-600 hover:bg-slate-50",
              )}
            >
              <span className="size-2 rounded-full" style={{ background: STATUS_META[status].color }} />
              {STATUS_META[status].label}
            </button>
          );
        })}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="max-w-56 font-mono text-xs">
            <span className="truncate">{installerLabel}</span> <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {[...project.installers, UNASSIGNED].map((name) => (
            <DropdownMenuCheckboxItem
              key={name || "unassigned"}
              checked={ui.installer.includes(name)}
              onCheckedChange={(checked) =>
                ui.setInstaller(checked ? [...ui.installer, name] : ui.installer.filter((value) => value !== name))
              }
              onSelect={(event) => event.preventDefault()}
            >
              {name || "Unassigned"}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="flex items-center gap-1.5">
        <Checkbox id="only-in-view" checked={ui.onlyInView} onCheckedChange={(checked) => ui.setOnlyInView(checked === true)} />
        <Label htmlFor="only-in-view" className="text-xs">
          Only stores in map view
        </Label>
      </div>
      {active ? (
        <Button variant="ghost" size="sm" onClick={ui.clearFilters}>
          <X /> Clear
        </Button>
      ) : null}
      <Button asChild variant="outline" size="sm">
        <a href={storeExportUrl(project.id, filters)} download>
          <Download /> CSV
        </a>
      </Button>
    </div>
  );
}
