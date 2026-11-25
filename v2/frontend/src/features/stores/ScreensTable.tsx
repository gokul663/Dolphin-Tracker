import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, Monitor, Tv } from "lucide-react";
import { InstallerName } from "@/features/installers/InstallerName";
import { hardwareCost } from "@/features/stores/details";
import { HardwareCostCell, Pager, type PagerProps } from "@/features/stores/StoresTable";
import type { Project, ScreenListRow } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";
import { cn } from "@/lib/utils";

interface Props extends Omit<PagerProps, "shown" | "noun"> {
  project: Project;
  rows: ScreenListRow[];
  sort: string;
  dir: "asc" | "desc";
  onSort: (sort: string) => void;
  selectedId: string | null;
  hoveredId: string | null;
  onHover: (uid: string | null) => void;
  onOpen: (uid: string) => void;
}

const dash = <span className="text-slate-300">—</span>;

interface Column {
  id: string;
  header: string;
  /** Server sort key; none = not sortable (the cost is worked out on the page from the price list). */
  sort?: string;
  size: number;
  grow?: number;
  cell: (row: ScreenListRow, project: Project) => ReactNode;
}

/** One row per screen: its DD code, the store it is at, then the screen's own status, cost, size, owner and brand. */
const COLUMNS: Column[] = [
  { id: "venue_id", header: "DD code", sort: "venue_id", size: 120, cell: (row) => <span className="font-mono text-xs">{row.screen.venue_id || dash}</span> },
  { id: "external_id", header: "ExtID", sort: "external_id", size: 92, cell: (row) => <span className="font-mono text-xs text-slate-600">{row.external_id || row.display_id}</span> },
  {
    id: "store_name",
    header: "Store name",
    sort: "store_name",
    size: 220,
    grow: 4,
    cell: (row) => (
      <span className="block truncate" title={row.store_name}>
        {row.store_name || dash}
      </span>
    ),
  },
  {
    id: "addr",
    header: "Address",
    sort: "addr",
    size: 200,
    grow: 3,
    cell: (row) => (
      <span className="block truncate" title={row.addr}>
        {row.addr || dash}
      </span>
    ),
  },
  { id: "city", header: "City", sort: "city", size: 120, grow: 1.5, cell: (row) => row.city || dash },
  { id: "state", header: "State", sort: "state", size: 62, cell: (row) => <span className="font-mono text-xs">{row.state || dash}</span> },
  {
    id: "status",
    header: "Screen status",
    sort: "status",
    size: 124,
    cell: (row) => (
      <span
        title={STATUS_META[row.screen.status].label}
        className={cn("inline-block w-[104px] truncate rounded border px-1.5 py-0.5 text-center text-xs font-medium", STATUS_META[row.screen.status].chip)}
      >
        {STATUS_META[row.screen.status].label}
      </span>
    ),
  },
  {
    id: "installer_name",
    header: "Installer",
    sort: "installer_name",
    size: 120,
    grow: 1.5,
    cell: (row) => {
      if (row.install_type === "Self install" || row.install_type === "Rep install") {
        return (
          <span className="inline-flex rounded-full border border-brand/30 bg-brand/10 px-2 py-0.5 text-xs font-semibold text-brand" title={row.install_type}>
            {row.install_type === "Self install" ? "Self" : "Rep"}
          </span>
        );
      }
      return row.installer_name ? <InstallerName name={row.installer_name} /> : dash;
    },
  },
  { id: "cost", header: "Cost", size: 96, cell: (row, project) => <HardwareCostCell cost={hardwareCost([row.screen], project.hardware_costs)} /> },
  { id: "screen_size", header: "Screen size", sort: "screen_size", size: 100, cell: (row) => <span className="font-mono text-xs">{row.screen.screen_size || dash}</span> },
  {
    id: "owner",
    header: "Owner",
    sort: "owner",
    size: 104,
    cell: (row) => {
      const Icon = row.screen.is_dolphin_screen ? Monitor : Tv;
      return (
        <span className="inline-flex items-center gap-1.5">
          <Icon size={14} className="text-slate-500" />
          {row.screen.is_dolphin_screen ? "Dolphin" : "Store"}
        </span>
      );
    },
  },
  { id: "brand", header: "Brand", sort: "brand", size: 110, grow: 1, cell: (row) => row.screen.screen_type || dash },
  { id: "venue_type", header: "Venue type", size: 140, grow: 1, cell: (row) => row.screen.venue_type || dash },
];

const columnStyle = (column: Column) => ({ flex: `${column.grow ?? 0.4} 0 ${column.size}px`, minWidth: column.size });
/** The columns for a project: without Cost when the project hides its hardware cost (Settings). */
const columnsFor = (project: Project) => (project.hardware_costs.hidden ? COLUMNS.filter((column) => column.id !== "cost") : COLUMNS);

/** The Screens view of the list: the same filters, paging and store window as the stores table, one row per screen.
 *  A click opens the screen's store. */
export function ScreensTable({ project, rows, sort, dir, onSort, selectedId, hoveredId, onHover, onOpen, ...pager }: Props) {
  const columns = columnsFor(project);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-white">
      <div className="min-h-0 flex-1 overflow-auto" role="grid" aria-rowcount={pager.total} aria-label="Screens">
        <div style={{ width: columns.reduce((sum, column) => sum + column.size, 0), minWidth: "100%" }}>
          <div role="row" className="sticky top-0 z-10 flex border-b bg-slate-50 font-mono text-[11px] uppercase tracking-wider text-slate-500">
            {columns.map((column) => {
              const active = column.sort !== undefined && sort === column.sort;
              return (
                <div key={column.id} role="columnheader" aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"} style={columnStyle(column)} className="px-2 py-2">
                  {column.sort ? (
                    <button type="button" className="flex items-center gap-1 uppercase hover:text-slate-800" onClick={() => onSort(column.sort!)}>
                      {column.header}
                      {active ? dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : <ChevronsUpDown size={12} className="opacity-40" />}
                    </button>
                  ) : (
                    column.header
                  )}
                </div>
              );
            })}
          </div>
          {rows.map((row, index) => (
            <div
              key={row.screen.id}
              role="row"
              aria-rowindex={pager.offset + index + 2}
              aria-selected={row.uid === selectedId}
              onMouseEnter={() => onHover(row.uid)}
              onMouseLeave={() => onHover(null)}
              onClick={() => onOpen(row.uid)}
              className={cn(
                "flex h-11 w-full cursor-pointer items-center border-b text-sm",
                row.uid === selectedId ? "bg-sky-100" : row.uid === hoveredId ? "bg-sky-50" : "hover:bg-slate-50",
              )}
            >
              {columns.map((column) => (
                <div key={column.id} role="gridcell" style={columnStyle(column)} className="truncate px-2">
                  {column.cell(row, project)}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      <Pager {...pager} shown={rows.length} noun="screens" />
    </div>
  );
}
