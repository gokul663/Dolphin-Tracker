import { useEffect, useMemo, useRef } from "react";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, ArrowDown, ArrowUp, ChevronsUpDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EditableCell } from "@/features/stores/EditableCell";
import { addressLine } from "@/features/stores/details";
import { useUpdateProgress, useUpdateStoreDetails } from "@/features/stores/api";
import { STOP_STATUSES, type Project, type Stop } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";
import { cn } from "@/lib/utils";
import { coreError, fieldError } from "@/lib/validation/fields";

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
  display_id: "display_id",
  store_name: "store_name",
  addr: "addr",
  status: "status",
  installer: "installer",
  day: "day",
};

export function StoresTable(props: Props) {
  const { project, stops, sort, dir, onSort, selectedId, hoveredId, onHover, onOpen } = props;
  const details = useUpdateStoreDetails(project.id);
  const progress = useUpdateProgress(project.id);

  const columns = useMemo<ColumnDef<Stop, string>[]>(() => {
    const saveDetails = (uid: string, body: Parameters<typeof details.mutateAsync>[0]["body"]) =>
      details.mutateAsync({ uid, body });
    const base: ColumnDef<Stop, string>[] = [
      helper.accessor("display_id", { header: "ID", size: 70, cell: (info) => <span className="font-mono text-xs text-slate-500">{info.getValue()}</span> }),
      helper.accessor("store_name", {
        header: "Store name",
        size: 220,
        cell: (info) => (
          <EditableCell
            label={`store name of ${info.row.original.display_id}`}
            value={info.getValue()}
            validate={(value) => coreError("store_name", value)}
            onSave={(value) => saveDetails(info.row.original.uid, { store_name: value })}
          />
        ),
      }),
      helper.accessor((stop) => addressLine(stop), {
        id: "addr",
        header: "Address",
        size: 300,
        cell: (info) => (
          <button
            type="button"
            className="flex w-full items-center gap-1 truncate text-left hover:text-brand"
            title="Open to edit the address (it is re-verified with Google)"
            onClick={(event) => {
              event.stopPropagation();
              onOpen(info.row.original.uid);
            }}
          >
            {info.row.original.route_stale && <AlertTriangle size={12} className="shrink-0 text-amber-600" aria-label="Route may be stale" />}
            <span className="truncate">{info.getValue()}</span>
          </button>
        ),
      }),
      helper.accessor((stop): string => stop.status, {
        id: "status",
        header: "Status",
        size: 160,
        cell: (info) => {
          const stop = info.row.original;
          return (
            <div onClick={(event) => event.stopPropagation()}>
              <Select
                value={stop.status}
                onValueChange={(value) =>
                  progress.mutate(
                    { uid: stop.uid, body: { status: value as Stop["status"] } },
                    { onError: (error) => toast.error(`Status not saved: ${error.message}`) },
                  )
                }
              >
                <SelectTrigger size="sm" aria-label={`Status of ${stop.display_id}`} className={cn("h-7 w-36 border", STATUS_META[stop.status].chip)}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STOP_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      <span className="size-2 rounded-full" style={{ background: STATUS_META[status].color }} />
                      {STATUS_META[status].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        },
      }),
      helper.accessor("installer", { header: "Installer", size: 120, cell: (info) => info.getValue() || <span className="text-slate-300">—</span> }),
      helper.accessor((stop) => String(stop.day), { id: "day", header: "Day", size: 60 }),
    ];
    const custom = project.field_schema.map((field) =>
      helper.accessor((stop) => (stop.fields[field.key] === undefined || stop.fields[field.key] === null ? "" : String(stop.fields[field.key])), {
        id: `fields.${field.key}`,
        header: field.label,
        size: 150,
        cell: (info) => (
          <EditableCell
            label={`${field.label} of ${info.row.original.display_id}`}
            value={info.getValue()}
            validate={(value) => fieldError(field, value)}
            onSave={(value) => saveDetails(info.row.original.uid, { fields: { [field.key]: value } })}
          />
        ),
      }),
    );
    return [...base, ...custom];
  }, [project.field_schema, onOpen]); // mutation objects are stable per project

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
