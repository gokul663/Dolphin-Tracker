import { useMemo, useState } from "react";
import { ChevronDown, Lock } from "lucide-react";
import { MapView } from "@/components/map/MapView";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { usePoolFacets, usePoolPins } from "@/features/planner/api";
import { poolKey, poolPins } from "@/features/planner/planModel";
import { US_STATE_NAMES } from "@/features/routes/routeModel";
import type { PoolFilters } from "@/lib/api/resources";
import type { FacetValue, PoolStore, StopStatus } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";
import { cn } from "@/lib/utils";

const TABLE_ROWS = 300;

interface Props {
  selected: Map<string, PoolStore>;
  onChange: (next: Map<string, PoolStore>) => void;
  /** Stores already in this plan show as locked, like stores in other plans. */
  planId?: string;
}

function Facet({
  label,
  values,
  selected,
  onToggle,
  render = (value: FacetValue) => value.label || value.value,
}: {
  label: string;
  values: FacetValue[] | undefined;
  selected: string[];
  onToggle: (value: string) => void;
  render?: (value: FacetValue) => string;
}) {
  const only = selected.length === 1 ? values?.find((value) => value.value === selected[0]) : undefined;
  const summary =
    selected.length === 0 ? `All ${label}` : selected.length > 1 ? `${selected.length} ${label}` : only ? render(only) : selected[0]!;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={!values?.length}>
        <Button
          variant="outline"
          size="sm"
          aria-label={`${label}: ${summary}`}
          className={cn("max-w-56 font-mono text-[11px]", selected.length > 0 && "border-slate-800 bg-slate-800 text-white hover:bg-slate-700 hover:text-white")}
        >
          <span className="truncate">{summary}</span>
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        {(values ?? []).map((value) => (
          <DropdownMenuCheckboxItem
            key={value.value}
            checked={selected.includes(value.value)}
            onCheckedChange={() => onToggle(value.value)}
            onSelect={(event) => event.preventDefault()}
          >
            <span className="flex-1">{render(value)}</span>
            <span className="font-mono text-[10px] text-slate-400">{value.count}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const toggle = (list: string[] | undefined, value: string) =>
  (list ?? []).includes(value) ? (list ?? []).filter((v) => v !== value) : [...(list ?? []), value];

/** Stores from every project, filtered by state, city, project and status; pick them on the map or in the table. */
export function StorePicker({ selected, onChange, planId }: Props) {
  const [filters, setFilters] = useState<PoolFilters>({ pending_only: true });
  const facets = usePoolFacets(filters);
  const pins = usePoolPins(filters);
  const matches = useMemo(() => pins.data ?? [], [pins.data]);
  const locked = (store: PoolStore) => Boolean(store.route_plan_id);
  const pickable = matches.filter((store) => !locked(store));
  const mapPins = useMemo(() => poolPins(matches), [matches]);
  const set = (patch: Partial<PoolFilters>) => setFilters((current) => ({ ...current, ...patch }));

  const flip = (store: PoolStore) => {
    if (locked(store)) return;
    const next = new Map(selected);
    if (next.has(poolKey(store))) next.delete(poolKey(store));
    else next.set(poolKey(store), store);
    onChange(next);
  };
  const selectAll = () => {
    const next = new Map(selected);
    for (const store of pickable) next.set(poolKey(store), store);
    onChange(next);
  };
  const clearMatching = () => {
    const next = new Map(selected);
    for (const store of matches) next.delete(poolKey(store));
    onChange(next);
  };
  const byKey = useMemo(() => new Map(matches.map((store) => [poolKey(store), store])), [matches]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Store filters">
        <Facet
          label="states"
          values={facets.data?.states}
          selected={filters.state ?? []}
          onToggle={(value) => set({ state: toggle(filters.state, value), city: [] })}
          render={(value) => `${US_STATE_NAMES[value.value] ?? value.value} (${value.value})`}
        />
        <Facet label="cities" values={facets.data?.cities} selected={filters.city ?? []} onToggle={(value) => set({ city: toggle(filters.city, value) })} />
        <Facet
          label="projects"
          values={facets.data?.projects}
          selected={filters.project_id ?? []}
          onToggle={(value) => set({ project_id: toggle(filters.project_id, value) })}
        />
        <label className="flex items-center gap-1.5 text-xs">
          <Checkbox checked={filters.pending_only ?? false} onCheckedChange={(on) => set({ pending_only: on === true })} />
          Pending only
        </label>
        <label className="flex items-center gap-1.5 text-xs">
          <Checkbox checked={filters.available_only ?? false} onCheckedChange={(on) => set({ available_only: on === true })} />
          Hide stores in a plan
        </label>
        <Input
          aria-label="Search stores"
          placeholder="Search name, IBC#, address…"
          value={filters.q ?? ""}
          onChange={(event) => set({ q: event.target.value })}
          className="h-8 w-56"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono text-xs text-slate-600" aria-live="polite">
          {pins.isFetching && !pins.data ? "Loading…" : `${matches.length} matching · ${selected.size} selected`}
          {matches.length - pickable.length > 0 && ` · ${matches.length - pickable.length} in a plan`}
        </span>
        <Button size="sm" variant="outline" onClick={selectAll} disabled={!pickable.length}>
          Select all {pickable.length} matching
        </Button>
        <Button size="sm" variant="ghost" onClick={clearMatching} disabled={!matches.some((s) => selected.has(poolKey(s)))}>
          Clear matching
        </Button>
        {selected.size > 0 && (
          <Button size="sm" variant="ghost" onClick={() => onChange(new Map())}>
            Clear all
          </Button>
        )}
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(320px,40%)]">
        <div className="max-h-[520px] overflow-auto rounded-xl border bg-white">
          <table className="w-full text-sm" aria-label="Matching stores">
            <thead className="sticky top-0 bg-slate-50 text-left font-mono text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="w-8 p-2" />
                <th className="p-2">Store</th>
                <th className="p-2">City</th>
                <th className="p-2">Project</th>
                <th className="p-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {matches.slice(0, TABLE_ROWS).map((store) => {
                const key = poolKey(store);
                const inPlan = locked(store);
                return (
                  <tr key={key} className={cn(inPlan && "bg-slate-50 text-slate-400")}>
                    <td className="p-2">
                      {inPlan ? (
                        <Lock className="size-3.5" aria-label={store.route_plan_id === planId ? "Already in this plan" : "In another plan"} />
                      ) : (
                        <Checkbox aria-label={`Select ${store.store_name}`} checked={selected.has(key)} onCheckedChange={() => flip(store)} />
                      )}
                    </td>
                    <td className="p-2">
                      <div className="font-medium">{store.store_name}</div>
                      <div className="text-xs text-slate-500">
                        {store.addr}
                        {store.external_id ? ` · ${store.external_id}` : ""}
                        {inPlan ? (store.route_plan_id === planId ? " · in this plan" : " · in another plan") : ""}
                      </div>
                    </td>
                    <td className="p-2 text-xs">
                      {store.city} {store.state}
                    </td>
                    <td className="p-2 text-xs">{store.project_name}</td>
                    <td className="p-2">
                      <span className={cn("rounded border px-1.5 py-0.5 text-[10px]", STATUS_META[store.status as StopStatus]?.chip)}>{store.status}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {matches.length > TABLE_ROWS && (
            <p className="p-3 text-center font-mono text-[10px] text-slate-500">
              Showing {TABLE_ROWS} of {matches.length}. Narrow the filters, or use "Select all matching".
            </p>
          )}
          {!pins.isFetching && matches.length === 0 && <p className="p-6 text-center text-sm text-slate-500">No stores match these filters.</p>}
        </div>
        <MapView
          className="h-[520px]"
          pins={mapPins}
          onSelect={(key) => {
            const store = byKey.get(key);
            if (store) flip(store);
          }}
        />
      </div>
    </div>
  );
}
