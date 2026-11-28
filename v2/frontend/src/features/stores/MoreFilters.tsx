import { useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Search, SlidersHorizontal, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Segmented } from "@/components/Segmented";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DateRangeFilter } from "@/features/stores/DateRangeFilter";
import { COMPARE_LABELS, FACET_LABELS, NUMBER_LABELS, RANGE_LABELS, facetOptions, optionLabel } from "@/features/stores/filters";
import type { ScreenStatus, StoreFilterOptions } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";
import { cn } from "@/lib/utils";
import {
  COMPARE_OPS, numberActive, rangeActive, useStoresUi,
  type DateRangeFilter as RangeName, type DateRanges, type Facet, type FacetSelection, type NumberFilter, type NumberFilters,
} from "@/stores/ui";

type Entry = { facet: Facet } | { range: RangeName } | { number: NumberFilter };

/** The panel's filters by kind. The status groups keep their chips above the search, so they are not repeated here. */
export const PANEL_GROUPS: { title: string; entries: Entry[] }[] = [
  { title: "Location", entries: [{ facet: "state" }, { facet: "city" }, { facet: "dma" }, { facet: "venue_type" }, { facet: "pa" }] },
  {
    title: "Screens",
    entries: [
      // The status chips above the bar, so what is picked there shows as ticked here too.
      { facet: "bucket" }, { facet: "status" }, { facet: "dd_code" }, { facet: "screen_size" }, { number: "screens_committed" }, { number: "screens_installed" },
      { facet: "committed_over_installed" }, { facet: "fulfilled" },
    ],
  },
  { title: "Mounts", entries: [{ facet: "mount" }, { number: "mounts_needed" }, { number: "mounts_installed" }] },
  { title: "Dolphin Data", entries: [{ range: "first_registered" }, { range: "last_registered" }] },
  {
    title: "Work",
    entries: [
      { facet: "installer" }, { facet: "technician" }, { facet: "install_type" }, { facet: "route" }, { facet: "visit" }, { facet: "tag" },
      { facet: "review" },
    ],
  },
];

/** The facets the filter bar shows inline (the two registration dates are in the bar too); the button's badge counts
 *  only the panel's other filters. */
export const INLINE_FACETS: readonly Facet[] = ["status", "state", "city", "dma", "dd_code", "tag"];
const PANEL_ONLY = PANEL_GROUPS.flatMap((group) => group.entries).filter(
  (entry): entry is { facet: Facet } => "facet" in entry && entry.facet !== "bucket" && !INLINE_FACETS.includes(entry.facet),
);

/** Filters active in the panel and not in the bar: one per facet with something picked, one per number comparison. */
export function panelActiveCount(facets: FacetSelection, numbers: NumberFilters): number {
  return PANEL_ONLY.filter(({ facet }) => facets[facet].length > 0).length + Object.values(numbers).filter(numberActive).length;
}

interface Selection {
  facets: FacetSelection;
  ranges: DateRanges;
  numbers: NumberFilters;
}

const entryActive = (entry: Entry, ui: Selection) =>
  "facet" in entry ? ui.facets[entry.facet].length > 0 : "range" in entry ? rangeActive(ui.ranges[entry.range]) : numberActive(ui.numbers[entry.number]);

/** Active filters in one section, inline ones included (they are shown there too). */
export const sectionActiveCount = (title: string, ui: Selection) =>
  PANEL_GROUPS.find((group) => group.title === title)?.entries.filter((entry) => entryActive(entry, ui)).length ?? 0;

/** Which sections were left open, for the session; a section with an active filter always opens. */
const SECTIONS_KEY = "dt.moreFilters.sections";
function storedSections(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SECTIONS_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}
function storeSections(open: Record<string, boolean>) {
  try {
    window.localStorage.setItem(SECTIONS_KEY, JSON.stringify(open));
  } catch {
    // Private mode or storage blocked: the panel just forgets.
  }
}

/** Beyond this many values a list asks for a search instead of drawing them all (a project can have hundreds of
 *  cities or DD codes). */
const SHOWN_VALUES = 40;
/** A list this short needs no search box. */
const SEARCH_FROM = 8;

/** "More Filters": a button with the number of active filters that live only in the panel, and the panel itself on
 *  the right, every filter grouped by kind in collapsible sections. Changes apply at once, as in the bar. The panel
 *  is not modal, so the list, map and chips behind it follow each change. */
export function MoreFilters({ options }: { options: StoreFilterOptions | undefined }) {
  const [open, setOpen] = useState(false);
  const [sections, setSections] = useState<Record<string, boolean>>({});
  const trigger = useRef<HTMLButtonElement>(null);
  const ui = useStoresUi(
    useShallow((state) => ({
      facets: state.facets,
      ranges: state.ranges,
      numbers: state.numbers,
      toggleFacet: state.toggleFacet,
      clearPanelFilters: state.clearPanelFilters,
    })),
  );
  const count = panelActiveCount(ui.facets, ui.numbers);
  const allActive = PANEL_GROUPS.reduce((sum, group) => sum + sectionActiveCount(group.title, ui), 0);
  // PA is offered only when the project has more than one (as the bar did).
  const hidden = (facet: Facet) => facet === "pa" && (options?.pa?.length ?? 0) <= 1 && ui.facets.pa.length === 0;
  const show = (next: boolean) => {
    if (next) {
      const stored = storedSections();
      setSections(Object.fromEntries(PANEL_GROUPS.map((group) => [group.title, sectionActiveCount(group.title, ui) > 0 || stored[group.title] === true])));
    }
    setOpen(next);
  };
  const toggleSection = (title: string) =>
    setSections((current) => {
      const next = { ...current, [title]: !current[title] };
      storeSections(next);
      return next;
    });
  return (
    <>
      <Button
        ref={trigger}
        variant="outline"
        size="sm"
        aria-label={count ? `More Filters (${count} active)` : "More Filters"}
        aria-expanded={open}
        onClick={() => show(!open)}
        className={cn("font-mono text-xs", count > 0 && "border-brand/40 bg-brand/10 text-brand hover:bg-brand/15 hover:text-brand")}
      >
        <SlidersHorizontal /> More Filters
        {count > 0 && (
          <span className="rounded-full bg-brand-magenta px-1.5 text-[10px] font-semibold leading-4 text-white" aria-hidden>
            {count}
          </span>
        )}
      </Button>
      <Sheet open={open} onOpenChange={show} modal={false}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="glass w-full gap-0 overflow-hidden sm:inset-y-2 sm:right-2 sm:h-auto sm:max-w-md sm:rounded-2xl"
          // The button toggles the panel itself; a click on it is not an outside click that closes it first.
          onInteractOutside={(event) => trigger.current?.contains(event.target as Node) && event.preventDefault()}
          // Escape or Close: back to the button that opened it.
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <SheetHeader className="flex-row items-center justify-between gap-2 border-b border-slate-900/[0.07] px-5 py-3.5">
            <div className="min-w-0">
              <SheetTitle className="font-display text-2xl leading-none font-normal tracking-[2.5px]">More Filters</SheetTitle>
              <SheetDescription className="mt-1 text-xs text-slate-600">
                {allActive ? `${allActive} active · ` : ""}Changes apply as you make them.
              </SheetDescription>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" className="h-9" onClick={ui.clearPanelFilters} disabled={allActive === 0}>
                Clear All
              </Button>
              <Button variant="ghost" size="icon" aria-label="Close filters" onClick={() => show(false)}>
                <X />
              </Button>
            </div>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2">
            {PANEL_GROUPS.map((group) => (
              <PanelSection key={group.title} title={group.title} active={sectionActiveCount(group.title, ui)} open={sections[group.title] === true} onToggle={() => toggleSection(group.title)}>
                {group.entries.map((entry) =>
                  "range" in entry ? (
                    <RangeField key={entry.range} name={entry.range} />
                  ) : "number" in entry ? (
                    <NumberField key={entry.number} name={entry.number} />
                  ) : hidden(entry.facet) ? null : (
                    <FacetList key={entry.facet} facet={entry.facet} options={options} selected={ui.facets[entry.facet]} onToggle={(value) => ui.toggleFacet(entry.facet, value)} />
                  ),
                )}
              </PanelSection>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

/** A section: a header button (chevron, and the number of active filters while closed) over its filters. */
function PanelSection({ title, active, open, onToggle, children }: { title: string; active: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  const id = useId();
  return (
    <section className="border-b border-slate-900/[0.07] last:border-b-0">
      <h3>
        <button
          type="button"
          id={`${id}-header`}
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={onToggle}
          className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left outline-none hover:bg-slate-900/[0.04] focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="font-display text-[19px] leading-none tracking-[1.5px] text-slate-900">{title}</span>
          {!open && active > 0 && (
            <span className="rounded-full bg-brand-magenta px-2 font-mono text-[11px] leading-5 font-semibold text-white">
              {active}
              <span className="sr-only"> active</span>
            </span>
          )}
          <ChevronDown aria-hidden className={cn("ml-auto size-4 text-slate-600 transition-transform motion-reduce:transition-none", open && "rotate-180")} />
        </button>
      </h3>
      <div id={`${id}-body`} role="region" aria-labelledby={`${id}-header`} hidden={!open} className="space-y-5 px-2 pt-1 pb-5">
        {open && children}
      </div>
    </section>
  );
}

/** A filter's name, marked (dot and a word, not colour alone) while it is active. */
function FieldLabel({ id, label, note }: { id: string; label: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span id={id} className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
        {note && <span className="size-1.5 rounded-full bg-brand" aria-hidden />}
        {label}
      </span>
      {note && <span className="font-mono text-[11px] font-medium text-brand">{note}</span>}
    </div>
  );
}

/** One facet as a list of checkboxes with counts; long lists get a search box and show the first matches only. */
function FacetList({ facet, options, selected, onToggle }: { facet: Facet; options: StoreFilterOptions | undefined; selected: string[]; onToggle: (value: string) => void }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const label = FACET_LABELS[facet];
  const all = facetOptions(options, facet, selected);
  const needle = query.trim().toLowerCase();
  const matching = needle ? all.filter((option) => optionLabel(facet, option.value).toLowerCase().includes(needle)) : all;
  // Picked values first, so they can be unticked without scrolling or searching.
  const ordered = [...matching.filter((option) => selected.includes(option.value)), ...matching.filter((option) => !selected.includes(option.value))];
  const shown = ordered.slice(0, Math.max(SHOWN_VALUES, selected.length));
  return (
    <div role="group" aria-labelledby={`${id}-label`} className="space-y-1.5">
      <FieldLabel id={`${id}-label`} label={label} note={selected.length ? `${selected.length} picked` : undefined} />
      {all.length === 0 ? (
        <p className="text-xs text-slate-600">No values</p>
      ) : (
        <>
          {all.length > SEARCH_FROM && (
            <div className="relative">
              <Search size={14} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-500" />
              <Input aria-label={`Search ${label}`} placeholder="Search…" value={query} onChange={(event) => setQuery(event.target.value)} className="h-9 bg-white pl-8 text-sm" />
            </div>
          )}
          <ul className={cn("-mx-1", all.length > SEARCH_FROM && "max-h-56 overflow-y-auto")}>
            {shown.map((option) => {
              const optionId = `${id}-${option.value || "blank"}`;
              const text = optionLabel(facet, option.value) || "(blank)";
              const picked = selected.includes(option.value);
              return (
                <li key={option.value || "(blank)"} className={cn("flex min-h-9 items-center gap-2.5 rounded-md px-1.5 hover:bg-slate-900/[0.04]", picked && "bg-brand/[0.07]")}>
                  <Checkbox id={optionId} aria-label={text} checked={picked} onCheckedChange={() => onToggle(option.value)} />
                  <label htmlFor={optionId} className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-2 text-sm text-slate-800">
                    {facet === "status" && <span className="size-2 shrink-0 rounded-full" style={{ background: STATUS_META[option.value as ScreenStatus]?.color }} />}
                    <span className="truncate">{text}</span>
                  </label>
                  <span className="font-mono text-xs text-slate-600 tabular-nums">{option.count}</span>
                </li>
              );
            })}
          </ul>
          {matching.length === 0 && <p className="text-xs text-slate-600">No match</p>}
          {ordered.length > shown.length && (
            <p className="text-xs text-slate-600">
              {ordered.length - shown.length} more: search to narrow the list
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** A number filter: higher than / lower than / equal to, and a whole number; an empty number is off. */
function NumberField({ name }: { name: NumberFilter }) {
  const id = useId();
  const comparison = useStoresUi((state) => state.numbers[name]);
  const setNumber = useStoresUi((state) => state.setNumber);
  const label = NUMBER_LABELS[name];
  const active = numberActive(comparison);
  return (
    <div role="group" aria-labelledby={`${id}-label`} className="space-y-1.5">
      <FieldLabel id={`${id}-label`} label={label} note={active ? `${COMPARE_LABELS[comparison.op].symbol} ${Number(comparison.value)}` : undefined} />
      <div className="flex items-center gap-2">
        <Segmented
          label={`${label}: comparison`}
          options={COMPARE_OPS.map((op) => ({ value: op, text: COMPARE_LABELS[op].symbol, name: COMPARE_LABELS[op].name }))}
          value={comparison.op}
          onChange={(op) => setNumber(name, { ...comparison, op })}
          className="[&_button]:w-10 [&_button]:text-sm"
        />
        <Input
          inputMode="numeric"
          aria-label={`${label}: number`}
          placeholder="Any"
          value={comparison.value}
          onChange={(event) => setNumber(name, { ...comparison, value: event.target.value.replace(/\D/g, "").slice(0, 6) })}
          className="h-9 w-20 bg-white text-center tabular-nums"
        />
        {active && (
          <Button variant="ghost" size="icon" aria-label={`Clear ${label}`} onClick={() => setNumber(name, { ...comparison, value: "" })}>
            <X />
          </Button>
        )}
      </div>
    </div>
  );
}

/** A registration-date filter: the same picker as in the bar, full width. */
function RangeField({ name }: { name: RangeName }) {
  const id = useId();
  const range = useStoresUi((state) => state.ranges[name]);
  return (
    <div role="group" aria-labelledby={`${id}-label`} className="space-y-1.5">
      <FieldLabel id={`${id}-label`} label={RANGE_LABELS[name]} note={rangeActive(range) ? "Set" : undefined} />
      <DateRangeFilter name={name} wide />
    </div>
  );
}

