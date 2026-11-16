import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Download, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { storeExportUrl, useStoreSuggestions } from "@/features/stores/api";
import { addressLine } from "@/features/stores/details";
import type { StoreFilters } from "@/lib/api/resources";
import type { Project, Stop } from "@/lib/api/types";
import { useShallow } from "zustand/react/shallow";
import { useStoresUi } from "@/stores/ui";
import { anyFacet, FACET_LABELS, optionLabel } from "@/features/stores/filters";
import type { Facet } from "@/stores/ui";
import { cn } from "@/lib/utils";

/** "Only stores in map view" and the CSV export, for the status line above the search and filters. */
export function StoresListActions({ project, filters }: { project: Project; filters: StoreFilters }) {
  const onlyInView = useStoresUi((state) => state.onlyInView);
  const setOnlyInView = useStoresUi((state) => state.setOnlyInView);
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1.5">
        <Checkbox id="only-in-view" checked={onlyInView} onCheckedChange={(checked) => setOnlyInView(checked === true)} />
        <Label htmlFor="only-in-view" className="text-xs">
          Only stores in map view
        </Label>
      </div>
      <Button asChild variant="outline" size="sm">
        <a href={storeExportUrl(project.id, filters)} download>
          <Download /> CSV
        </a>
      </Button>
    </div>
  );
}

/** The search (IBC#, name, address, with the closest stores as you type) and the filter dropdowns (`children`);
 *  under them, while anything narrows the list, one chip per active filter (each with its own ×) and Clear all. */
export function StoresToolbar({
  project,
  filters: _filters,
  children,
  onPick,
}: {
  project: Project;
  filters: StoreFilters;
  children?: ReactNode;
  /** Open a store picked from the search suggestions (the Stores tab); without it, picking searches its name. */
  onPick?: (uid: string) => void;
}) {
  // Only the slices the toolbar shows: hover, selection and map bounds never re-render it.
  const ui = useStoresUi(
    useShallow((state) => ({
      search: state.search,
      facets: state.facets,
      onlyInView: state.onlyInView,
      setSearch: state.setSearch,
      needsAttention: state.needsAttention,
      setNeedsAttention: state.setNeedsAttention,
      setOnlyInView: state.setOnlyInView,
      toggleFacet: state.toggleFacet,
      clearFilters: state.clearFilters,
    })),
  );
  const [draft, setDraft] = useState(ui.search);
  useEffect(() => setDraft(ui.search), [ui.search]);
  useEffect(() => {
    const timer = window.setTimeout(() => draft !== ui.search && ui.setSearch(draft), 250);
    return () => window.clearTimeout(timer);
  }, [draft]); // only the draft drives the debounce; `ui` is the stable store
  const active = ui.search || anyFacet(ui.facets) || ui.onlyInView || ui.needsAttention;

  // Everything narrowing the list, one chip each: the search text, every picked filter value (also the ones
  // without a drop-down, set from a link or a header bubble), and the two switches.
  const chips: { key: string; label: string; onRemove: () => void }[] = [
    ...(ui.search ? [{ key: "q", label: `Search: ${ui.search}`, onRemove: () => { setDraft(""); ui.setSearch(""); } }] : []),
    ...(Object.keys(ui.facets) as Facet[]).flatMap((facet) =>
      ui.facets[facet].map((value) => ({
        key: `${facet}:${value}`,
        label: `${FACET_LABELS[facet]}: ${optionLabel(facet, value) || "(blank)"}`,
        onRemove: () => ui.toggleFacet(facet, value),
      })),
    ),
    ...(ui.onlyInView ? [{ key: "view", label: "Only stores in map view", onRemove: () => ui.setOnlyInView(false) }] : []),
  ];

  return (
    <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-1.5">
      <StoreSearch projectId={project.id} value={draft} onChange={setDraft} onPick={(stop) => (onPick ? onPick(stop.uid) : setDraft(stop.store_name))} />
      {children}
    </div>
    {active ? (
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
      {ui.needsAttention && (
        <Button
          size="sm"
          variant="outline"
          className="border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
          aria-pressed
          onClick={() => ui.setNeedsAttention(false)}
          title="Showing only stores that need attention: no name, an unverified address, or Completed but not in the Dolphin data"
        >
          <AlertTriangle /> Needs attention <X />
        </Button>
      )}
      <Button variant="ghost" size="sm" className="h-7" onClick={ui.clearFilters}>
        <X /> Clear all
      </Button>
    </div>
    ) : null}
    </div>
  );
}

/** The search box: IBC#, store name or address. As you type, the five closest stores drop down; Enter (or just
 *  pausing) filters the list by the text instead. */
function StoreSearch({
  projectId,
  value,
  onChange,
  onPick,
}: {
  projectId: string;
  value: string;
  onChange: (value: string) => void;
  onPick: (stop: Stop) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const needle = value.trim();
  const suggestions = useStoreSuggestions(projectId, open ? needle : "");
  const items = suggestions.data?.items ?? [];
  const pick = (stop: Stop) => {
    setOpen(false);
    setActive(-1);
    onPick(stop);
  };
  return (
    <div className="relative w-72 shrink-0">
      <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
      <Input
        role="combobox"
        aria-label="Search stores"
        aria-expanded={open && items.length > 0}
        aria-controls="store-suggestions"
        aria-autocomplete="list"
        placeholder="Search IBC#, store name or address…"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)} // let a click on a suggestion land first
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") setActive((index) => Math.min(index + 1, items.length - 1));
          else if (event.key === "ArrowUp") setActive((index) => Math.max(index - 1, -1));
          else if (event.key === "Escape") setOpen(false);
          else if (event.key === "Enter") {
            if (active >= 0 && items[active]) pick(items[active]!);
            else setOpen(false);
          } else return;
          event.preventDefault();
        }}
        className="h-8 pl-9 text-sm"
      />
      {open && needle.length > 0 && items.length > 0 && (
        <ul id="store-suggestions" role="listbox" aria-label="Closest stores" className="absolute left-0 right-0 top-9 z-30 overflow-hidden rounded-md border bg-white py-1 shadow-lg">
          {items.map((stop, index) => (
            <li
              key={stop.uid}
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(stop)}
              onMouseEnter={() => setActive(index)}
              className={cn("cursor-pointer px-3 py-1.5 text-sm", index === active ? "bg-sky-50" : "hover:bg-slate-50")}
            >
              <span className="flex items-baseline gap-2">
                <span className="font-mono text-[11px] text-slate-500">{stop.external_id || stop.display_id}</span>
                <span className="truncate font-medium text-slate-800">{stop.device?.store_name || stop.store_name}</span>
              </span>
              <span className="block truncate text-xs text-slate-500">{addressLine(stop)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
