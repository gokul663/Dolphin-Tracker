import { useEffect, useMemo, useRef } from "react";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, ArrowDown, ArrowUp, ChevronsUpDown, Loader2 } from "lucide-react";
import { EditableCell } from "@/features/stores/EditableCell";
import { addressLine } from "@/features/stores/details";
import { useUpdateStoreDetails } from "@/features/stores/api";
import type { Project, Stop } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";
import { cn } from "@/lib/utils";
import { coreError } from "@/lib/validation/fields";

const ROW_HEIGHT = 44;

interface Props {
  project: Project;
  stops: Stop[];
  total: number | null;
  hasNextPage: boolean;
  fetchingNext: boolean;
  fetchNextPage: () => void;
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
  installer: "installer",
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
const count = (value: number | null) => (value === null ? "—" : String(value));

export function StoresTable(props: Props) {
  const { project, stops, sort, dir, onSort, selectedId, hoveredId, onHover, onOpen } = props;
  const details = useUpdateStoreDetails(project.id);

  const columns = useMemo<ColumnDef<Stop, string>[]>(
    () => [
      helper.accessor("external_id", {
        header: "IBC#",
        size: 110,
        cell: (info) => <span className="font-mono text-xs text-slate-600">{info.getValue() || info.row.original.display_id}</span>,
      }),
      helper.accessor("store_name", {
        header: "Store name",
        size: 220,
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
        size: 170,
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
        size: 150,
        cell: (info) => (
          <span
            aria-label={`Status of ${info.row.original.external_id || info.row.original.display_id}`}
            className={cn("rounded border px-1.5 py-0.5 text-xs font-medium", STATUS_META[info.row.original.status].chip)}
          >
            {STATUS_META[info.row.original.status].label}
          </span>
        ),
      }),
      helper.accessor((stop) => String(stop.screens.length), { id: "screens", header: "Screens", size: 120, cell: (info) => <ScreenDots stop={info.row.original} /> }),
      helper.accessor((stop) => (stop.installer ? `${stop.installer} · day ${stop.day}` : ""), {
        id: "installer",
        header: "Installer / day",
        size: 140,
        cell: (info) => info.getValue() || dash,
      }),
      helper.accessor((stop) => stop.pa || project.pa, { id: "pa", header: "PA", size: 100, cell: (info) => info.getValue() || dash }),
      helper.accessor("dma", { header: "DMA", size: 90, cell: (info) => info.getValue() || dash }),
      helper.accessor((stop) => `${count(stop.committed_dolphin_screens)} / ${count(stop.committed_store_tvs)}`, {
        id: "committed",
        header: "Committed Dolphin / TVs",
        size: 150,
        cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
      }),
    ],
    [project.pa, onOpen], // the mutation object is stable per project
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

  // Load the next page as the end comes into view.
  const last = items.at(-1)?.index ?? -1;
  useEffect(() => {
    if (props.hasNextPage && !props.fetchingNext && last >= rows.length - 10) props.fetchNextPage();
  }, [last, rows.length, props.hasNextPage, props.fetchingNext, props.fetchNextPage]);

  // A pin click selects a store: bring its row into view.
  useEffect(() => {
    if (!selectedId) return;
    const index = rows.findIndex((row) => row.id === selectedId);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
  }, [selectedId]); // only when the selection changes, not on every page load

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-white">
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto" role="grid" aria-rowcount={props.total ?? rows.length} aria-label="Stores">
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
                  aria-rowindex={item.index + 2}
                  aria-selected={uid === selectedId}
                  data-uid={uid}
                  onMouseEnter={() => onHover(uid)}
                  onMouseLeave={() => onHover(null)}
                  onClick={() => onOpen(uid)}
                  style={{ transform: `translateY(${item.start}px)`, height: ROW_HEIGHT }}
                  className={cn(
                    "absolute left-0 top-0 flex w-full cursor-pointer items-center border-b text-sm",
                    uid === selectedId ? "bg-sky-100" : uid === hoveredId ? "bg-sky-50" : "hover:bg-slate-50",
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
      <div className="flex items-center justify-between border-t px-3 py-1.5 font-mono text-[10px] text-slate-500">
        <span>
          {rows.length} loaded{props.hasNextPage ? " · scroll for more" : ""}
        </span>
        {props.fetchingNext && <Loader2 size={12} className="animate-spin" />}
      </div>
    </div>
  );
}
