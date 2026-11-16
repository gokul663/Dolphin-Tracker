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
  Monitor,
  Route,
  Tv,
} from "lucide-react";
import { useRoutePlans } from "@/features/planner/api";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { visitState } from "@/features/visits/visitForm";
import { addressLine, fulfillment, hardwareCost, money } from "@/features/stores/details";
import { STORE_PAGE_SIZES } from "@/features/stores/api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Project, Stop } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";
import { DEVICE_TONE } from "@/features/device/DeviceBits";
import { cn } from "@/lib/utils";

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
  install_type: "install_type",
  installer_name: "installer_name",
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

/** How much of the spare width each column takes when the table is wider than its columns: the store name and DMA
 *  the most, the short fixed ones (status, counts) little. Header and rows use the same, so they stay aligned. */
const GROW: Record<string, number> = { store_name: 4, dma: 1, place: 2, installer_name: 1.5, servicing: 1, pa: 1 };
const columnStyle = (id: string, size: number) => ({ flex: `${GROW[id] ?? 0.4} 0 ${size}px`, minWidth: size });

/** A total of Dolphin screens + store TVs; hovering shows the two apart. Unknown (no count in the sheet) is a dash. */
function TotalCount({ screens, tvs, label, tone, suffix }: { screens: number | null; tvs: number | null; label: string; tone?: string; suffix?: ReactNode }) {
  if (screens === null && tvs === null) return dash;
  const total = (screens ?? 0) + (tvs ?? 0);
  const part = (value: number | null, one: string, many: string) => (value === null ? `? ${many}` : `${value} ${value === 1 ? one : many}`);
  const detail = `${part(screens, "Dolphin screen", "Dolphin screens")} · ${part(tvs, "store TV", "store TVs")}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn("inline-flex cursor-default items-center gap-1 rounded px-1 font-mono text-sm tabular-nums underline decoration-dotted decoration-slate-300 underline-offset-4", tone ?? "text-slate-700")}
          aria-label={`${label}: ${total} (${detail})`}
        >
          {total}
          {suffix}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <span className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1"><Monitor size={12} /> {part(screens, "Dolphin screen", "Dolphin screens")}</span>
          <span className="inline-flex items-center gap-1"><Tv size={12} /> {part(tvs, "store TV", "store TVs")}</span>
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/** A store's hardware cost, the sticks and screens behind it on hover; prices not set yet in Settings say so. */
function HardwareCostCell({ cost }: { cost: ReturnType<typeof hardwareCost> }) {
  if (cost.installed === 0) return dash;
  const breakdown = cost.lines.map((line) => `${line.count} × ${line.label}${line.price === null ? " (no price)" : ` @ ${money(line.price)}`}`).join("\n");
  if (cost.total === null) {
    return (
      <span className="text-xs text-amber-700" title={`Set the ${cost.missing.join(", ")} price in Settings\n${breakdown}`}>
        Set prices
      </span>
    );
  }
  return (
    <span className="font-mono text-sm tabular-nums text-slate-800" title={breakdown} aria-label={`Hardware cost ${money(cost.total)}`}>
      {money(cost.total)}
    </span>
  );
}

export const ATTENTION_LABELS: Record<string, string> = {
  store_name: "no store name",
  address: "address not verified",
  not_reporting: "Completed but not in Dolphin data",
  dd_code_review: "a DD code entry holds several codes",
  external_id: "no IBC#",
};

/** A value from the Dolphin data, in its colour; the sheet's value on hover. Clicking opens the store. */
function DeviceValue({ value, sheet, onOpen }: { value: string; sheet: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      className={cn("block w-full truncate text-left hover:underline", DEVICE_TONE.text)}
      title={sheet && sheet !== value ? `Dolphin data. Sheet: ${sheet}` : "Dolphin data"}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      {value}
    </button>
  );
}

/** ROUTE-PLANNER §6: stores being tended (in a route) and serviced ones stand out in the list. A fulfilled store
 *  is marked by the check next to its installed count, not by the row. */
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

/** One PA name (no comma list): every store shares it. */
export const singlePa = (pa: string) => pa.trim() !== "" && !pa.includes(",");

export function StoresTable(props: Props) {
  const { project, stops, sort, dir, onSort, selectedId, hoveredId, onHover, onOpen } = props;
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
                  aria-label={`Needs attention: ${reasons.map((r) => ATTENTION_LABELS[r] ?? r).join(", ")}`}
                />
              )}
              {info.getValue() || info.row.original.display_id}
            </span>
          );
        },
      }),
      helper.accessor("store_name", {
        header: "Store name",
        size: 240,
        cell: (info) => {
          const shown = info.row.original.device?.store_name;
          // The Dolphin data's name shows over the sheet's; it is changed in the store (Overwrite), not here.
          if (shown) return <DeviceValue value={shown} sheet={info.getValue()} onOpen={() => onOpen(info.row.original.uid)} />;
          // Not edited here: a click anywhere on the row opens the store.
          return (
            <span className="block truncate" title={info.getValue()}>
              {info.getValue() || dash}
            </span>
          );
        },
      }),
      helper.accessor((stop) => [stop.device?.city || stop.city, stop.device?.state || stop.state].filter(Boolean).join(", "), {
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
            {info.row.original.route_stale && info.row.original.route_plan_id && <AlertTriangle size={12} className="shrink-0 text-amber-600" aria-label="Route may be stale" />}
            <span className={cn("truncate", (info.row.original.device?.city || info.row.original.device?.state) && DEVICE_TONE.text)}>
              {info.getValue() || "—"}
            </span>
          </button>
        ),
      }),
      helper.accessor("dma", { header: "DMA", size: 130, cell: (info) => info.getValue() || dash }),
      helper.accessor((stop): string => stop.status, {
        id: "status",
        header: "Status",
        size: 112,
        cell: (info) => (
          <span
            aria-label={`Status of ${info.row.original.external_id || info.row.original.display_id}`}
            title={STATUS_META[info.row.original.status].label}
            // One width for every status, so the column lines up; long labels are cut with an ellipsis.
            className={cn("inline-block w-[92px] truncate rounded border px-1.5 py-0.5 text-center text-xs font-medium", STATUS_META[info.row.original.status].chip)}
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
      helper.accessor("installer_name", {
        header: "Installer",
        size: 120,
        // The technician's name; a self or rep install sends no technician, so it shows as a pill instead.
        cell: (info) => {
          const type = info.row.original.install_type;
          if (type === "Self install" || type === "Rep install") {
            return (
              <span className="inline-flex rounded-full border border-brand/30 bg-brand/10 px-2 py-0.5 text-xs font-semibold text-brand" title={type}>
                {type === "Self install" ? "Self" : "Rep"}
              </span>
            );
          }
          return info.getValue() || dash;
        },
      }),

      helper.accessor((stop) => String((stop.committed_dolphin_screens ?? 0) + (stop.committed_store_tvs ?? 0)), {
        id: "committed",
        header: "Screens committed",
        size: 96,
        cell: (info) => (
          <TotalCount label="Screens committed" screens={info.row.original.committed_dolphin_screens} tvs={info.row.original.committed_store_tvs} />
        ),
      }),
      helper.accessor((stop) => String(fulfillment(stop).installed), {
        id: "installed",
        header: "Screens installed",
        size: 96,
        cell: (info) => {
          const done = fulfillment(info.row.original);
          return (
            <TotalCount
              label="Screens installed"
              screens={done.installedScreens}
              tvs={done.installedTvs}
              tone={done.fulfilled ? "font-semibold text-green-700" : undefined}
              suffix={done.fulfilled ? <Check size={13} className="text-green-700" aria-label="fulfilled" /> : undefined}
            />
          );
        },
      }),
      helper.accessor((stop) => String(hardwareCost(stop.screens, project.hardware_costs).total ?? ""), {
        id: "hardware",
        header: "Hardware cost",
        size: 110,
        cell: (info) => <HardwareCostCell cost={hardwareCost(info.row.original.screens, project.hardware_costs)} />,
      }),
    ],
    [project.pa, project.hardware_costs, onOpen, planNames, hidePa], // the mutation object is stable per project
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
          <div role="row" className="sticky top-0 z-10 flex border-b bg-slate-50 font-mono text-[11px] uppercase tracking-wider text-slate-500">
            {table.getFlatHeaders().map((header) => {
              const key = SORT_KEYS[header.id] ?? (header.id.startsWith("fields.") ? header.id : null);
              const active = key !== null && sort === key;
              return (
                <div key={header.id} role="columnheader" aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"} style={columnStyle(header.column.id, header.getSize())} className="px-2 py-2">
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
                    <div key={cell.id} role="gridcell" style={columnStyle(cell.column.id, cell.column.getSize())} className="truncate px-2">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {/* Under the rows, just above the pages. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-1.5 text-xs text-slate-600" aria-label="Table legend">
        <span>Screens = Dolphin screens + store TVs; hover a count to see them apart</span>
        <span className="inline-flex items-center gap-1">
          <Check size={13} className="text-green-700" aria-hidden /> Installed ≥ committed
        </span>
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
    <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-1.5 font-mono text-xs text-slate-600">
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
        <Select value={String(pageSize)} onValueChange={(value) => onPageSize(Number(value))}>
          <SelectTrigger size="sm" aria-label="Rows per page" className="ml-2 h-7 w-[104px] font-mono text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" side="top" align="end">
            {STORE_PAGE_SIZES.map((size) => (
              <SelectItem key={size} value={String(size)} className="font-mono text-xs">
                {size} / page
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
