import { useMemo, useState } from "react";
import { Download, Loader2, RefreshCw, Shuffle } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { MapView } from "@/components/map/MapView";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useProjectContext } from "@/features/projects/ProjectPage";
import { useReassignStop, useRoutes, useRoutingJob } from "@/features/projects/api";
import { DayCard } from "@/features/routes/DayCard";
import {
  allCsvRows,
  filenameSlug,
  filterDays,
  filterOptions,
  installerColor,
  installerSummary,
  NO_FILTERS,
  territoryTag,
  toCsv,
  US_STATE_NAMES,
  type RouteFilters,
} from "@/features/routes/routeModel";
import { SummaryTable } from "@/features/routes/SummaryTable";
import { StoreDrawer } from "@/features/stores/StoreDrawer";
import type { Pin, Stop } from "@/lib/api/types";
import { downloadText } from "@/lib/download";
import { cn } from "@/lib/utils";

const ALL = "__all__";

/** React port of the legacy route planner over the routes bundle. */
export function RoutesTab() {
  const project = useProjectContext();
  const routes = useRoutes(project.id);
  const job = useRoutingJob(project.id);
  const reassign = useReassignStop(project.id);
  const [active, setActive] = useState<string>(ALL);
  const [view, setView] = useState<"cards" | "summary">("cards");
  const [filters, setFilters] = useState<RouteFilters>(NO_FILTERS);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"rebalance" | "recluster" | null>(null);
  const [moving, setMoving] = useState<{ stop: Stop; to: string } | null>(null);

  const bundle = routes.data;
  const options = useMemo(() => (bundle ? filterOptions(bundle.routes) : null), [bundle]);
  const installers = bundle ? (active === ALL ? bundle.installers : [active]) : [];
  const pins: Pin[] = useMemo(
    () =>
      (bundle ? (active === ALL ? bundle.installers : [active]) : []).flatMap((installer) =>
        filterDays(bundle?.routes[installer] ?? [], filters).flatMap(({ stops }) =>
          stops.flatMap((stop) =>
            stop.lat !== null && stop.lng !== null
              ? [{ uid: stop.uid, lat: stop.lat, lng: stop.lng, status: stop.status, store_name: stop.store_name, installer, day: stop.day, route_plan_id: "", visit_state: "none" as const }]
              : [],
          ),
        ),
      ),
    [bundle, active, filters],
  );
  const set = (patch: Partial<RouteFilters>) => setFilters((current) => ({ ...current, ...patch }));
  const building = project.routing_status === "building";

  const runJob = async (kind: "rebalance" | "recluster") => {
    try {
      await job.mutateAsync({ kind });
      toast.success(kind === "rebalance" ? "Rebalancing upcoming stores…" : "Rebuilding all routes…");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start routing");
    } finally {
      setConfirm(null);
    }
  };
  const runReassign = async () => {
    if (!moving) return;
    try {
      const result = await reassign.mutateAsync({ uid: moving.stop.uid, installer: moving.to });
      toast.success(`Moved ${moving.stop.store_name} to ${result.installer}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Reassign failed");
    } finally {
      setMoving(null);
    }
  };

  if (routes.isPending) return <Card className="p-8 text-center font-mono text-slate-500">Loading routes…</Card>;
  if (routes.isError || !bundle) {
    return (
      <Card className="items-center gap-3 p-8 text-center text-rose-700">
        Could not load routes: {routes.error?.message}
        <Button variant="outline" size="sm" onClick={() => routes.refetch()}>
          Retry
        </Button>
      </Card>
    );
  }

  const filterSelect = (label: string, value: string, values: string[], onChange: (v: string) => void, render = (v: string) => v) => (
    <Select value={value || ALL} onValueChange={(next) => onChange(next === ALL ? "" : next)}>
      <SelectTrigger size="sm" aria-label={label} className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All {label}</SelectItem>
        {values.map((option) => (
          <SelectItem key={option} value={option}>
            {render(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const shown = installers.filter((installer) => filterDays(bundle.routes[installer] ?? [], filters).length > 0);

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Installers" className="flex flex-wrap gap-1.5">
        {bundle.installers.map((installer) => {
          const stats = bundle.stats[installer];
          return (
            <button
              key={installer}
              role="tab"
              aria-selected={active === installer}
              onClick={() => setActive(installer)}
              className={cn(
                "flex items-center gap-2 rounded-lg border-2 bg-white px-3 py-1.5 text-sm font-semibold",
                active === installer && "shadow-sm ring-2 ring-offset-1",
              )}
              style={{ borderColor: installerColor(bundle.installers, installer) }}
            >
              {installer}
              <span className="rounded bg-slate-100 px-1.5 font-mono text-[10px] font-normal text-slate-600">
                {territoryTag(bundle.routes, installer)}
              </span>
              {stats && (
                <span className="font-mono text-[10px] font-normal text-slate-500">
                  {stats.total} stops · {stats.days} days · {stats.miles} mi
                </span>
              )}
            </button>
          );
        })}
        <button
          role="tab"
          aria-selected={active === ALL}
          onClick={() => setActive(ALL)}
          className={cn("ml-auto rounded-lg border-2 bg-white px-3 py-1.5 text-sm font-semibold", active === ALL && "border-brand")}
        >
          All installers
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={view} onValueChange={(value) => setView(value as "cards" | "summary")}>
          <TabsList>
            <TabsTrigger value="cards">Day cards</TabsTrigger>
            <TabsTrigger value="summary">Summary</TabsTrigger>
          </TabsList>
        </Tabs>
        <Input aria-label="Days" placeholder="Days, e.g. 1, 3" value={filters.days} onChange={(e) => set({ days: e.target.value })} className="h-8 w-32" />
        {options && filterSelect("PAs", filters.pa, options.pa, (pa) => set({ pa }))}
        {options && filterSelect("DMAs", filters.dma, options.dma, (dma) => set({ dma }))}
        {options && filterSelect("venue types", filters.venueType, options.venueType, (venueType) => set({ venueType }))}
        {options && filterSelect("states", filters.state, options.state, (state) => set({ state }), (code) => US_STATE_NAMES[code] ?? code)}
        {options && filterSelect("cities", filters.city, options.city, (city) => set({ city }))}
        <Input aria-label="Search routes" placeholder="Search…" value={filters.q} onChange={(e) => set({ q: e.target.value })} className="h-8 w-48" />
        <div className="ml-auto flex flex-wrap gap-1.5">
          {view === "cards" && (
            <>
              <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set())}>
                Expand all
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setCollapsed(new Set(bundle.installers.flatMap((i) => (bundle.routes[i] ?? []).map((_, d) => `${i}|${d + 1}`))))}
              >
                Collapse all
              </Button>
            </>
          )}
          <Button size="sm" variant="outline" disabled={building || job.isPending} onClick={() => setConfirm("rebalance")}>
            <Shuffle /> Rebalance upcoming
          </Button>
          <Button size="sm" variant="outline" disabled={building || job.isPending} onClick={() => setConfirm("recluster")}>
            <RefreshCw /> Rebuild all routes
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              downloadText(
                toCsv(allCsvRows(bundle, filters, project.field_schema)),
                `${filenameSlug(project.name)}_all_routes_${new Date().toISOString().slice(0, 10)}.csv`,
              )
            }
          >
            <Download /> All routes CSV
          </Button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,32%)]">
        <div className="min-w-0 space-y-5">
          {building && (
            <p className="flex items-center gap-2 font-mono text-xs text-sky-700">
              <Loader2 className="size-3 animate-spin" /> Routes are being rebuilt; this view refreshes when the build finishes.
            </p>
          )}
          {view === "summary" ? (
            <SummaryTable bundle={bundle} installers={installers} filters={filters} />
          ) : shown.length === 0 ? (
            <p className="rounded-xl border bg-white p-8 text-center text-sm text-slate-500">
              {bundle.installers.length && Object.values(bundle.routes).some((days) => days.length)
                ? "No stops match these filters."
                : bundle.installers.length === 0
                  ? "No installers yet. Add the first installer in Settings and the routes are built for every store."
                  : "No routes yet. Routes appear once the routing build has assigned stores to installers."}
            </p>
          ) : (
            shown.map((installer) => {
              const color = installerColor(bundle.installers, installer);
              const days = bundle.routes[installer] ?? [];
              const summary = installerSummary(days, filters);
              return (
                <section key={installer} className="space-y-2" aria-label={`${installer} routes`}>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <h2 className="font-display text-2xl tracking-[2px]" style={{ color }}>
                      {installer}
                    </h2>
                    <span className="rounded bg-slate-100 px-1.5 font-mono text-[10px] text-slate-600">{territoryTag(bundle.routes, installer)}</span>
                    <span className="font-mono text-xs text-slate-500">
                      {summary.total} sites · {summary.activeDays} active days · ~{summary.averageActive} active stops/day · {summary.complete} done ·{" "}
                      {summary.pending} upcoming · {summary.offline} offline · {summary.other} other
                    </span>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                    {filterDays(days, filters).map(({ day, stops }) => {
                      const key = `${installer}|${day}`;
                      return (
                        <DayCard
                          key={key}
                          project={project}
                          installer={installer}
                          color={color}
                          day={day}
                          totalDays={days.length}
                          stops={stops}
                          collapsed={collapsed.has(key)}
                          onToggle={() =>
                            setCollapsed((current) => {
                              const next = new Set(current);
                              if (next.has(key)) next.delete(key);
                              else next.add(key);
                              return next;
                            })
                          }
                          onEdit={setEditing}
                          onReassign={(stop, to) => setMoving({ stop, to })}
                        />
                      );
                    })}
                  </div>
                </section>
              );
            })
          )}
        </div>
        <MapView className="h-[420px] xl:sticky xl:top-20 xl:h-[calc(100vh-7rem)]" pins={pins} selectedId={editing} onSelect={setEditing} />
      </div>

      <StoreDrawer project={project} stopId={editing} open={editing !== null} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={confirm !== null}
        title={confirm === "rebalance" ? "Rebalance upcoming stores?" : "Rebuild all routes?"}
        confirmLabel={confirm === "rebalance" ? "Rebalance" : "Rebuild"}
        busy={job.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && runJob(confirm)}
      >
        {confirm === "rebalance"
          ? "Only upcoming stores move between installers and days. Completed and other stores keep their installer and day."
          : `Every store is re-clustered across ${bundle.installers.length} installers at ${bundle.stops_per_day} stops per day. Status, comments and other progress are kept.`}
      </ConfirmDialog>
      <ConfirmDialog
        open={moving !== null}
        title="Reassign this store?"
        confirmLabel="Reassign"
        busy={reassign.isPending}
        onCancel={() => setMoving(null)}
        onConfirm={runReassign}
      >
        Move <strong>{moving?.stop.store_name}</strong> ({moving?.stop.addr}, {moving?.stop.city}) from{" "}
        <strong>{moving?.stop.installer}</strong> to <strong>{moving?.to}</strong>. Other stores stay on their days.
      </ConfirmDialog>
    </div>
  );
}
