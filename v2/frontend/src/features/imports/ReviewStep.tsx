import { useMemo, useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useValidateAddress } from "@/features/places/api";
import { applyGeocode, filterRows, reviewSummary, rowProblems, type ReviewRow, type RowFilter } from "@/features/imports/model";
import { cn } from "@/lib/utils";

const PAGE = 100;

interface Props {
  rows: ReviewRow[];
  onRowsChange: (update: (rows: ReviewRow[]) => ReviewRow[]) => void;
}

/** Step 3: fix what Google could not verify, fill missing store names, or exclude rows. */
export function ReviewStep({ rows, onRowsChange }: Props) {
  const summary = reviewSummary(rows);
  const initial: RowFilter = summary.blocked ? "blocked" : "all";
  const [filter, setFilter] = useState<RowFilter>(initial);
  // The filter is a snapshot taken when it is chosen: a row being fixed stays in view (and its input mounted)
  // even once it no longer matches. Choosing a filter again refreshes the snapshot.
  const [pinned, setPinned] = useState<Set<number>>(() => new Set(filterRows(rows, initial).map((row) => row.index)));
  const [page, setPage] = useState(0);
  const visible = useMemo(
    () => (filter === "all" ? rows : rows.filter((row) => pinned.has(row.index))),
    [rows, filter, pinned],
  );
  const applyFilter = (next: RowFilter) => {
    setFilter(next);
    setPinned(new Set(filterRows(rows, next).map((row) => row.index)));
    setPage(0);
  };
  const pages = Math.max(1, Math.ceil(visible.length / PAGE));
  const shown = visible.slice(page * PAGE, page * PAGE + PAGE);
  const validate = useValidateAddress();

  const patch = (index: number, change: Partial<ReviewRow>) =>
    onRowsChange((current) => current.map((row) => (row.index === index ? { ...row, ...change } : row)));

  const verify = async (row: ReviewRow, address: string) => {
    if (!address.trim()) return;
    patch(row.index, { address, status: "validating" });
    try {
      const geo = await validate.mutateAsync(address.trim());
      onRowsChange((current) => current.map((r) => (r.index === row.index ? applyGeocode(r, geo, address) : r)));
    } catch {
      patch(row.index, { status: "needs_review", error: "Could not reach the address check" });
    }
  };

  const chip = (value: RowFilter, label: string, count: number, tone: string, Icon?: typeof CheckCircle2) => (
    <button
      type="button"
      aria-pressed={filter === value}
      onClick={() => applyFilter(filter === value && value !== "all" ? "all" : value)}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-xs",
        filter === value ? "border-slate-800 bg-slate-800 text-white" : tone,
      )}
    >
      {Icon && <Icon size={12} />} {count} {label}
    </button>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {chip("all", "all rows", summary.total, "bg-slate-50 text-slate-700")}
        {chip("valid", "valid", summary.valid, "border-emerald-300 bg-emerald-50 text-emerald-700", CheckCircle2)}
        {chip("needs_review", "need review", summary.needs_review, "border-amber-300 bg-amber-50 text-amber-700", AlertTriangle)}
        {summary.invalid > 0 && chip("invalid", "invalid", summary.invalid, "border-rose-300 bg-rose-50 text-rose-700", AlertCircle)}
        {chip("blocked", "to fix or exclude", summary.blocked, "border-rose-300 bg-white text-rose-700")}
        <span className="ml-auto self-center font-mono text-xs text-slate-500">
          {summary.ready} ready · {summary.excluded} excluded
        </span>
      </div>
      <div className="max-h-[50vh] overflow-auto rounded-lg border">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            <tr className="text-left">
              <th className="p-2">#</th>
              <th className="p-2">Store name *</th>
              <th className="p-2">Address *</th>
              <th className="p-2">Status</th>
              <th className="p-2">Suggestion</th>
              <th className="p-2 text-center">Exclude</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-slate-500">
                  Nothing in this view.
                </td>
              </tr>
            )}
            {shown.map((row) => {
              const problems = rowProblems(row);
              return (
                <tr key={row.index} className={cn("border-t align-top", row.excluded && "opacity-50")}>
                  <td className="p-2 font-mono text-xs text-slate-500">{row.index + 1}</td>
                  <td className="p-2">
                    <Input
                      aria-label={`Store name, row ${row.index + 1}`}
                      value={row.store_name}
                      aria-invalid={!row.excluded && !row.store_name.trim()}
                      onChange={(event) => patch(row.index, { store_name: event.target.value })}
                      className="h-8"
                    />
                  </td>
                  <td className="p-2">
                    <Input
                      aria-label={`Address, row ${row.index + 1}`}
                      defaultValue={row.address}
                      key={`${row.index}-${row.address}`}
                      onBlur={(event) => event.target.value !== row.address && verify(row, event.target.value)}
                      className="h-8"
                    />
                    {row.formatted && row.status !== "validating" && (
                      <div className="mt-1 truncate text-xs text-slate-500" title={row.formatted}>
                        → {row.formatted}
                      </div>
                    )}
                    {!row.excluded && problems.length > 0 && <div className="mt-1 text-xs text-rose-600">{problems.join(" · ")}</div>}
                    {row.error && row.status !== "valid" && <div className="text-xs text-amber-700">{row.error}</div>}
                  </td>
                  <td className="p-2">
                    <StatusChip row={row} />
                  </td>
                  <td className="p-2">
                    {row.suggestions.length > 0 && row.status !== "valid" ? (
                      <Select onValueChange={(value) => verify(row, value)}>
                        <SelectTrigger aria-label={`Suggestions, row ${row.index + 1}`} className="h-8 w-56">
                          <SelectValue placeholder="Pick a suggestion…" />
                        </SelectTrigger>
                        <SelectContent>
                          {row.suggestions.map((suggestion) => (
                            <SelectItem key={suggestion} value={suggestion}>
                              {suggestion}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                  <td className="p-2 pt-3.5 text-center">
                    <Checkbox
                      aria-label={`Exclude row ${row.index + 1}`}
                      checked={row.excluded}
                      onCheckedChange={(checked) => patch(row.index, { excluded: checked === true })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 font-mono text-xs">
          <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          Page {page + 1} / {pages}
          <Button size="sm" variant="outline" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
            Next
          </Button>
        </div>
      )}
      {summary.blocked > 0 && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRowsChange((current) => current.map((row) => (rowProblems(row).length ? { ...row, excluded: true } : row)))}
          >
            Exclude the {summary.blocked} rows that still need fixing
          </Button>
        </div>
      )}
    </div>
  );
}

function StatusChip({ row }: { row: ReviewRow }) {
  if (row.status === "validating")
    return (
      <span className="inline-flex items-center gap-1 font-mono text-xs text-slate-500">
        <Loader2 size={12} className="animate-spin" /> Checking
      </span>
    );
  const tone = {
    valid: "border-emerald-200 bg-emerald-50 text-emerald-700",
    needs_review: "border-amber-200 bg-amber-50 text-amber-700",
    invalid: "border-rose-200 bg-rose-50 text-rose-700",
  }[row.status];
  const label = { valid: "Valid", needs_review: "Review", invalid: "Invalid" }[row.status];
  return (
    <span className={cn("inline-flex rounded-full border px-2 py-0.5 font-mono text-[11px]", tone)} title={row.verified_by.join(", ")}>
      {label} · {row.confidence}
    </span>
  );
}
