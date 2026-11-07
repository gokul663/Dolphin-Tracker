import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Link } from "react-router";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUpDown,
  Loader2,
  Route,
} from "lucide-react";
import { useRoutePlans } from "@/features/planner/api";
import { visitState } from "@/features/visits/visitForm";
import { EditableCell } from "@/features/stores/EditableCell";
import { addressLine } from "@/features/stores/details";
import { STORE_PAGE_SIZES, useUpdateStoreDetails } from "@/features/stores/api";
import type { Project, Stop } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";
import { cn } from "@/lib/utils";
import { coreError } from "@/lib/validation/fields";

const ROW_HEIGHT = 44;

interface Props {
  project: Project;
  stops: Stop[];
  /** Stores matching the filters (all pages); `offset` is where this page starts. */
  total: number;
  offset: number;
  pageSize: number;
  fetching: boolean;
  onPage: (index: number) => void;
  onPageSize: (size: number) => void;
  sort: string;
  dir: "asc" | "desc";
  onSort: (sort: string) => void;
  selectedId: string | null;
  hoveredId: string | null;
  onHover: (uid: string | null) => void;
  onOpen: (uid: string) => void;
}

const helper = createColumnHelper<Stop>();
/** Server sort key per column; columns without one are not sortable (the API cannot sort them). */
const SORT_KEYS: Record<string, string> = {
  external_id: "external_id",
  store_name: "store_name",
  place: "city",
  status: "status",
  screens: "screens",
  pa: "pa",
  dma: "dma",
  committed: "committed_dolphin_screens",
};

/** One dot per screen in its status colour: the row's mini status summary. */
function ScreenDots({ stop }: { stop: Stop }) {
  const counts = new Map<Stop["status"], number>();
  for (const screen of stop.screens) counts.set(screen.status, (counts.get(screen.status) ?? 0) + 1);
  const summary = [...counts].map(([status, count]) => `${count} ${STATUS_META[status].label}`).join(", ");
  return (
    <span className="flex items-center gap-1.5" title={summary} aria-label={`${stop.screens.length} screens: ${summary}`}>
      <span className="font-mono text-xs">{stop.screens.length}</span>
      <span className="flex flex-wrap gap-0.5">
        {stop.screens.slice(0, 12).map((screen) => (
          <span key={screen.id} className="size-2 rounded-full" style={{ background: STATUS_META[screen.status].color }} />
        ))}
        {stop.screens.length > 12 && <span className="text-[10px] text-slate-400">+{stop.screens.length - 12}</span>}
      </span>
    </span>
  );
}

const dash = <span className="text-slate-300">—</span>;

/** ROUTE-PLANNER §6: stores being tended (in a route) and serviced ones stand out in the list. */
function rowTint(stop: Stop): string {
  if (stop.route_plan_id) return "bg-blue-50/60 hover:bg-blue-50";
  const state = visitState(stop);
  if (state === "visited") return "bg-emerald-50/60 hover:bg-emerald-50";
  if (state === "partly") return "bg-amber-50/50 hover:bg-amber-50";
  return "hover:bg-slate-50";
}

function ServicingCell({ stop, planNames }: { stop: Stop; planNames: Map<string, string> }) {
  const state = visitState(stop);
  const visited = stop.screens.filter((screen) => {
    const at = stop.screen_visits[screen.id];
    return Boolean(at) && (at as string) >= stop.last_planned_at;
  }).length;
  return (
    <span className="flex items-center gap-1 truncate text-xs">
      {stop.route_plan_id && (
        <Link
          to={`/planner/${stop.route_plan_id}`}
          onClick={(event) => event.stopPropagation()}
          className="inline-flex max-w-32 items-center gap-1 truncate rounded bg-blue-100 px-1.5 py-0.5 font-medium text-blue-800 hover:underline"
          title="In route: open the plan"
        >
          <Route size={11} className="shrink-0" /> <span className="truncate">{planNames.get(stop.route_plan_id) ?? "In route"}</span>
        </Link>
      )}
      {state === "visited" && (
        <span className="inline-flex items-center gap-0.5 rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-800" title={`Last visit ${stop.last_visit_at.slice(0, 10)}`}>
          <Check size={11} /> Visited
        </span>
      )}
      {state === "partly" && (
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800" title={`Last visit ${stop.last_visit_at.slice(0, 10)}`}>
          {visited}/{stop.screens.length} sticks
        </span>
      )}
      {!stop.route_plan_id && state === "none" && (stop.last_visit_at ? <span className="text-slate-400">last {stop.last_visit_at.slice(0, 10)}</span> : dash)}
    </span>
  );
}
const count = (value: number | null) => (value === null ? "—" : String(value));

/** One PA name (no comma list): every store shares it. */
export const singlePa = (pa: string) => pa.trim() !== "" && !pa.includes(",");

export function StoresTable(props: Props) {
  const { project, stops, sort, dir, onSort, selectedId, hoveredId, onHover, onOpen } = props;
  const details = useUpdateStoreDetails(project.id);
  const plans = useRoutePlans("active");
  const planNames = useMemo(() => new Map((plans.data ?? []).map((plan) => [plan.id, plan.name])), [plans.data]);
  const hidePa = singlePa(project.pa) && stops.every((stop) => !stop.pa.trim() || stop.pa.trim() === project.pa.trim());

  const columns = useMemo<ColumnDef<Stop, string>[]>(
    () => [
      helper.accessor("external_id", {
        header: "IBC#",
        size: 92,
        cell: (info) => {
          const reasons = info.row.original.needs_attention ?? [];
          return (
            <span className="flex items-center gap-1 font-mono text-xs text-slate-600">
              {reasons.length > 0 && (
                <AlertTriangle
                  size={12}
                  className="shrink-0 text-amber-600"
                  aria-label={`Needs attention: ${reasons.map((r) => (r === "store_name" ? "no store name" : "address not verified")).join(", ")}`}
                />
              )}
              {info.getValue() || info.row.original.display_id}
            </span>
          );
        },
      }),
      helper.accessor("store_name", {
        header: "Store name",
        size: 200,
        cell: (info) => (
          <EditableCell
            label={`store name of ${info.row.original.external_id || info.row.original.display_id}`}
            value={info.getValue()}
            validate={(value) => coreError("store_name", value)}
            onSave={(value) => details.mutateAsync({ uid: info.row.original.uid, body: { store_name: value } })}
          />
        ),
      }),
      helper.accessor((stop) => [stop.city, stop.state].filter(Boolean).join(", "), {
        id: "place",
        header: "City, state",
        size: 145,
        cell: (info) => (
          <button
            type="button"
            className="flex w-full items-center gap-1 truncate text-left hover:text-brand"
            title={`${addressLine(info.row.original)} (open to edit; the address is re-verified with Google)`}
            onClick={(event) => {
              event.stopPropagation();
              onOpen(info.row.original.uid);
            }}
          >
            {info.row.original.route_stale && <AlertTriangle size={12} className="shrink-0 text-amber-600" aria-label="Route may be stale" />}
            <span className="truncate">{info.getValue() || "—"}</span>
          </button>
        ),
      }),
      helper.accessor((stop): string => stop.status, {
        id: "status",
        header: "Status",
        size: 112,
        cell: (info) => (
          <span
            aria-label={`Status of ${info.row.original.external_id || info.row.original.display_id}`}
            className={cn("rounded border px-1.5 py-0.5 text-xs font-medium", STATUS_META[info.row.original.status].chip)}
          >
            {STATUS_META[info.row.original.status].label}
          </span>
        ),
      }),
      helper.accessor((stop) => String(stop.screens.length), { id: "screens", header: "Screens", size: 78, cell: (info) => <ScreenDots stop={info.row.original} /> }),
      helper.accessor((stop) => stop.route_plan_id, {
        id: "servicing",
        header: "Route / visits",
        size: 150,
        cell: (info) => <ServicingCell stop={info.row.original} planNames={planNames} />,
      }),
      // A single-PA project shows its PA in the header: the column would repeat it on every row (it stays when a
      // store on this page carries a PA of its own).
      ...(hidePa
        ? []
        : [helper.accessor((stop) => stop.pa || project.pa, { id: "pa", header: "PA", size: 90, cell: (info) => info.getValue() || dash })]),
      helper.accessor("dma", { header: "DMA", size: 80, cell: (info) => info.getValue() || dash }),
      helper.accessor((stop) => `${count(stop.committed_dolphin_screens)} / ${count(stop.committed_store_tvs)}`, {
        id: "committed",
        header: "Committed Dolphin / TVs",
        size: 130,
        cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
      }),
    ],
    [project.pa, onOpen, planNames, hidePa], // the mutation object is stable per project
  );

  const table = useReactTable({ data: stops, columns, getCoreRowModel: getCoreRowModel(), manualSorting: true, getRowId: (stop) => stop.uid });
  const rows = table.getRowModel().rows;
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    initialRect: { width: 1200, height: 640 }, // first paint before measuring (and jsdom, which measures 0)
  });
  const items = virtualizer.getVirtualItems();
  const width = table.getTotalSize();

  // A new page starts at its top row.
  useEffect(() => {
    scroller.current?.scrollTo?.({ top: 0 });
  }, [props.offset]);

  // A pin click selects a store: bring its row into view.
  useEffect(() => {
    if (!selectedId) return;
    const index = rows.findIndex((row) => row.id === selectedId);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
  }, [selectedId]); // only when the selection changes, not on every page load

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-white">
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto" role="grid" aria-rowcount={props.total} aria-label="Stores">
        <div style={{ width, minWidth: "100%" }}>
          <div role="row" className="sticky top-0 z-10 flex border-b bg-slate-50 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            {table.getFlatHeaders().map((header) => {
              const key = SORT_KEYS[header.id] ?? (header.id.startsWith("fields.") ? header.id : null);
              const active = key !== null && sort === key;
              return (
                <div key={header.id} role="columnheader" aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"} style={{ width: header.getSize() }} className="shrink-0 px-2 py-2">
                  {key ? (
                    <button type="button" className="flex items-center gap-1 uppercase hover:text-slate-800" onClick={() => onSort(key)}>
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {active ? dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : <ChevronsUpDown size={12} className="opacity-40" />}
                    </button>
                  ) : (
                    flexRender(header.column.columnDef.header, header.getContext())
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {items.map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              const uid = row.original.uid;
              return (
                <div
                  key={row.id}
                  role="row"
                  aria-rowindex={props.offset + item.index + 2}
                  aria-selected={uid === selectedId}
                  data-uid={uid}
                  onMouseEnter={() => onHover(uid)}
                  onMouseLeave={() => onHover(null)}
                  onClick={() => onOpen(uid)}
                  style={{ transform: `translateY(${item.start}px)`, height: ROW_HEIGHT }}
                  className={cn(
                    "absolute left-0 top-0 flex w-full cursor-pointer items-center border-b text-sm",
                    uid === selectedId ? "bg-sky-100" : uid === hoveredId ? "bg-sky-50" : rowTint(row.original),
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <div key={cell.id} role="gridcell" style={{ width: cell.column.getSize() }} className="shrink-0 truncate px-2">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <Pager {...props} shown={rows.length} />
    </div>
  );
}

/** "51–100 of 482", first/previous/next/last page, a page number box and the page size. */
function Pager({ total, offset, pageSize, fetching, onPage, onPageSize, shown }: Props & { shown: number }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const index = Math.floor(offset / pageSize);
  const [draft, setDraft] = useState(String(index + 1));
  useEffect(() => setDraft(String(index + 1)), [index]);
  const go = (next: number) => onPage(Math.min(pages - 1, Math.max(0, next)));
  const jump = () => {
    const number = Number(draft);
    if (Number.isInteger(number)) go(number - 1);
    else setDraft(String(index + 1));
  };
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-1.5 font-mono text-[11px] text-slate-600">
      <span aria-live="polite">
        {total ? `${offset + 1}–${offset + shown} of ${total.toLocaleString()}` : "0 stores"}
        {fetching && <Loader2 size={12} className="ml-2 inline animate-spin" />}
      </span>
      <div className="flex items-center gap-1">
        <PageButton label="First page" disabled={index === 0} onClick={() => go(0)}>
          <ChevronsLeft size={14} />
        </PageButton>
        <PageButton label="Previous page" disabled={index === 0} onClick={() => go(index - 1)}>
          <ChevronLeft size={14} />
        </PageButton>
        <span className="flex items-center gap-1 px-1">
          Page
          <input
            aria-label="Page number"
            className="h-6 w-10 rounded border px-1 text-center"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={jump}
            onKeyDown={(event) => event.key === "Enter" && jump()}
          />
          of {pages}
        </span>
        <PageButton label="Next page" disabled={index >= pages - 1} onClick={() => go(index + 1)}>
          <ChevronRight size={14} />
        </PageButton>
        <PageButton label="Last page" disabled={index >= pages - 1} onClick={() => go(pages - 1)}>
          <ChevronsRight size={14} />
        </PageButton>
        <select
          aria-label="Rows per page"
          className="ml-2 h-6 rounded border bg-white px-1"
          value={pageSize}
          onChange={(event) => onPageSize(Number(event.target.value))}
        >
          {STORE_PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size} / page
            </option>
          ))}
        </select>
      </div>
    </nav>
  );
}

function PageButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded border bg-white hover:bg-slate-50 disabled:opacity-40"
    >
      {children}
    </button>
  );
}
