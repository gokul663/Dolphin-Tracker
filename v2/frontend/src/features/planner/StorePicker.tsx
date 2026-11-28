import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Lock, RefreshCw, Search, X } from "lucide-react";
import { toast } from "sonner";
import { FacetDropdown, type FacetOption } from "@/components/FacetDropdown";
import { MapView } from "@/components/map/MapView";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { BucketChips } from "@/features/stores/BucketChips";
import { usePoolFacets, usePoolPins } from "@/features/planner/api";
import { poolKey, poolPins } from "@/features/planner/planModel";
import { US_STATE_NAMES } from "@/features/routes/routeModel";
import { keys } from "@/lib/api/keys";
import { storeSearchApi, type PoolFilters } from "@/lib/api/resources";
import type { FacetValue, PoolStore, StopStatus } from "@/lib/api/types";
import { BUCKET_LABEL, STATUS_META, STORE_BUCKETS, storeStatusLabel, type StatusBucket } from "@/lib/status";
import { cn } from "@/lib/utils";

const TABLE_ROWS = 300;

interface Props {
  selected: Map<string, PoolStore>;
  onChange: (next: Map<string, PoolStore>) => void;
  /** Stores already in this plan show as locked, like stores in other plans. */
  planId?: string;
}

const plain = (values: FacetValue[] | undefined): FacetOption[] => (values ?? []).map((value) => ({ value: value.value, label: value.label || value.value, count: value.count }));
/** Archived and cancelled stores are never routed, so the planner does not offer them. */
const ROUTED_BUCKETS = STORE_BUCKETS.filter((bucket) => bucket !== "Archived" && bucket !== "Cancelled");

const toggle = (list: string[] | undefined, value: string) =>
  (list ?? []).includes(value) ? (list ?? []).filter((v) => v !== value) : [...(list ?? []), value];

/** Stores from every project and every other venue of the CMS data (the ones in no project), filtered by status group, state, city, DMA and project; pick them on the map or in the table. */
export function StorePicker({ selected, onChange, planId }: Props) {
  const [filters, setFilters] = useState<PoolFilters>({ bucket: ["Upcoming"] });
  const facets = usePoolFacets(filters);
  const client = useQueryClient();
  // The update runs in the background: look again a few times while it fills in.
  const refresh = useMutation({
    mutationFn: storeSearchApi.refreshVenues,
    onSuccess: () => [20_000, 60_000, 120_000].forEach((wait) => window.setTimeout(() => void client.invalidateQueries({ queryKey: keys.storeSearch }), wait)),
  });
  const pins = usePoolPins(filters);
  const matches = useMemo(() => pins.data ?? [], [pins.data]);
  const locked = (store: PoolStore) => Boolean(store.route_plan_id);
  const pickable = matches.filter((store) => !locked(store));
  const mapPins = useMemo(() => poolPins(matches), [matches]);
  const set = (patch: Partial<PoolFilters>) => setFilters((current) => ({ ...current, ...patch }));

  const stateOptions: FacetOption[] = (facets.data?.states ?? []).map((value) => ({ value: value.value, label: US_STATE_NAMES[value.value] ? `${US_STATE_NAMES[value.value]} (${value.value})` : value.value, count: value.count }));
  const projectOptions = plain(facets.data?.projects);
  // Everything narrowing the list, one chip each with its own ×.
  const picked = (name: string, key: "state" | "city" | "dma" | "pa" | "project_id" | "bucket", labelOf: (value: string) => string = (value) => value) =>
    (filters[key] ?? []).map((value) => ({ key: `${key}:${value}`, label: `${name}: ${labelOf(value)}`, onRemove: () => set({ [key]: toggle(filters[key], value) }) }));
  const chips = [
    ...(filters.q ? [{ key: "q", label: `Search: ${filters.q}`, onRemove: () => set({ q: "" }) }] : []),
    ...picked("Status", "bucket", (value) => BUCKET_LABEL[value as StatusBucket] ?? value),
    ...picked("State", "state", (value) => US_STATE_NAMES[value] ?? value),
    ...picked("City", "city"),
    ...picked("DMA", "dma"),
    ...picked("PA", "pa"),
    ...picked("Project", "project_id", (value) => projectOptions.find((option) => option.value === value)?.label ?? value),
    ...(filters.available_only ? [{ key: "free", label: "Not in a plan", onRemove: () => set({ available_only: false }) }] : []),
  ];

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
      {/* One filter card, as on the Projects page: the status groups first, then search and the other filters,
          then a chip for everything that narrows the list. */}
      <Card className="gap-2.5 p-3" role="group" aria-label="Store filters">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <BucketChips buckets={ROUTED_BUCKETS} options={facets.data?.buckets} selected={filters.bucket ?? []} onToggle={(bucket) => set({ bucket: toggle(filters.bucket, bucket) })} />
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-slate-700">
              <Checkbox checked={filters.available_only ?? false} onCheckedChange={(on) => set({ available_only: on === true })} />
              Hide stores in a plan
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={refresh.isPending}
              title="Every venue of every PA in the CMS data is listed here, also the ones in no project. The daily sync updates them; this does it now."
              onClick={() =>
                refresh.mutate(undefined, {
                  onSuccess: () => toast.success("Updating every venue from the CMS data", { description: "It takes a minute or two; the list here follows." }),
                  onError: (error) => toast.error(error instanceof Error ? error.message : "Could not start the update"),
                })
              }
            >
              {refresh.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Update venues
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="relative w-72 shrink-0">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input aria-label="Search stores" placeholder="Search ExtID, store name or address…" value={filters.q ?? ""} onChange={(event) => set({ q: event.target.value })} className="h-8 pl-9 text-sm" />
          </div>
          <FacetDropdown label="State" options={stateOptions} selected={filters.state ?? []} onToggle={(value) => set({ state: toggle(filters.state, value), city: [] })} />
          <FacetDropdown label="City" options={plain(facets.data?.cities)} selected={filters.city ?? []} onToggle={(value) => set({ city: toggle(filters.city, value) })} />
          <FacetDropdown label="DMA" options={plain(facets.data?.dmas)} selected={filters.dma ?? []} onToggle={(value) => set({ dma: toggle(filters.dma, value) })} />
          <FacetDropdown label="PA" options={plain(facets.data?.pas)} selected={filters.pa ?? []} onToggle={(value) => set({ pa: toggle(filters.pa, value) })} />
          <FacetDropdown label="Project" options={projectOptions} selected={filters.project_id ?? []} onToggle={(value) => set({ project_id: toggle(filters.project_id, value) })} />
        </div>
        {chips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Active filters">
            <span className="font-mono text-[11px] uppercase tracking-wider text-slate-500">Filtered by</span>
            {chips.map((chip) => (
              <span key={chip.key} className="inline-flex items-center gap-1 rounded-full border border-brand/30 bg-brand/10 py-0.5 pl-2.5 pr-1 text-xs font-medium text-brand">
                {chip.label}
                <button type="button" aria-label={`Remove ${chip.label}`} onClick={chip.onRemove} className="rounded-full p-0.5 hover:bg-brand/20">
                  <X size={12} />
                </button>
              </span>
            ))}
            <Button variant="ghost" size="sm" className="h-7" onClick={() => setFilters({})}>
              <X /> Clear all
            </Button>
          </div>
        )}
      </Card>
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
                <th className="p-2">City · DMA</th>
                <th className="p-2">Project · PA</th>
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
                      {store.dma && <div className="text-[11px] text-slate-400">{store.dma}</div>}
                    </td>
                    <td className={cn("p-2 text-xs", store.project_id === "venues" && "text-slate-400")}>
                      {store.project_name}
                      {store.pa && <div className="text-[11px] text-slate-400">{store.pa}</div>}
                    </td>
                    <td className="p-2">
                      <span className={cn("whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px]", STATUS_META[store.status as StopStatus]?.chip)}>
                        {store.status in STATUS_META ? storeStatusLabel(store.status as StopStatus) : store.status}
                      </span>
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
