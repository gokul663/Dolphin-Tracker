import { useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Undo2,
} from "lucide-react";
import { GoogleSearchPicker } from "@/features/places/GoogleSearchPicker";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useValidateAddress } from "@/features/places/api";
import {
  applyGeocode,
  applyPlace,
  overridable,
  remember,
  undoPick,
  duplicateText,
  filterRows,
  isDuplicate,
  reviewSummary,
  rowProblems,
  screensPreview,
  valueProblems,
  type ReviewRow,
  type RowFilter,
} from "@/features/imports/model";
import { STATUS_META } from "@/lib/status";
import { cn } from "@/lib/utils";

const PAGE = 100;

interface Props {
  rows: ReviewRow[];
  onRowsChange: (update: (rows: ReviewRow[]) => ReviewRow[]) => void;
}

/** Fix what Google could not verify, fill a missing IBC# or store name, or exclude rows. Rows repeating an earlier
 *  row of the sheet (same IBC#, else same address) are excluded and say why (STORE-MODEL §1.4). */
export function ReviewStep({ rows, onRowsChange }: Props) {
  const summary = reviewSummary(rows);
  const initial: RowFilter = summary.blocked ? "blocked" : "all";
  const [filter, setFilter] = useState<RowFilter>(initial);
  // The filter is a snapshot taken when it is chosen: a row being fixed stays in view (and its input mounted)
  // even once it no longer matches. Choosing a filter again refreshes the snapshot.
  const [pinned, setPinned] = useState<Set<number>>(
    () => new Set(filterRows(rows, initial).map((row) => row.index)),
  );
  const [page, setPage] = useState(0);
  const visible = useMemo(
    () =>
      filter === "all" ? rows : rows.filter((row) => pinned.has(row.index)),
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
    onRowsChange((current) =>
      current.map((row) => (row.index === index ? { ...row, ...change } : row)),
    );

  const verify = async (row: ReviewRow, address: string) => {
    if (!address.trim()) return;
    patch(row.index, { address, status: "validating" });
    try {
      const geo = await validate.mutateAsync({
        address: address.trim(),
        name: row.store_name,
      });
      onRowsChange((current) =>
        current.map((r) =>
          r.index === row.index
            ? { ...applyGeocode(r, geo, address), previous: remember(row) }
            : r,
        ),
      );
    } catch {
      patch(row.index, {
        status: "needs_review",
        error: "Could not reach the address check",
      });
    }
  };

  const chip = (
    value: RowFilter,
    label: string,
    count: number,
    tone: string,
    Icon?: typeof CheckCircle2,
  ) => (
    <button
      type="button"
      aria-pressed={filter === value}
      onClick={() =>
        applyFilter(filter === value && value !== "all" ? "all" : value)
      }
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
        {chip(
          "valid",
          "valid",
          summary.valid,
          "border-emerald-300 bg-emerald-50 text-emerald-700",
          CheckCircle2,
        )}
        {chip(
          "needs_review",
          "need review",
          summary.needs_review,
          "border-amber-300 bg-amber-50 text-amber-700",
          AlertTriangle,
        )}
        {summary.invalid > 0 &&
          chip(
            "invalid",
            "invalid",
            summary.invalid,
            "border-rose-300 bg-rose-50 text-rose-700",
            AlertCircle,
          )}
        {chip(
          "blocked",
          "to fix or exclude",
          summary.blocked,
          "border-rose-300 bg-white text-rose-700",
        )}
        {summary.withValueProblems > 0 &&
          chip(
            "values",
            "with unusable values",
            summary.withValueProblems,
            "border-amber-300 bg-white text-amber-800",
          )}
        {summary.duplicates > 0 &&
          chip(
            "duplicates",
            "duplicates",
            summary.duplicates,
            "border-slate-300 bg-slate-50 text-slate-600",
          )}
        <span className="ml-auto self-center font-mono text-xs text-slate-500">
          {summary.ready} ready · {summary.excluded} excluded
        </span>
      </div>
      <div className="max-h-[50vh] overflow-auto rounded-lg border">
        <table className="w-full min-w-[1240px] text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            <tr className="text-left">
              <th className="p-2">#</th>
              <th className="p-2">IBC# *</th>
              <th className="w-60 p-2">Store name *</th>
              <th className="min-w-80 p-2">Address *</th>
              <th className="w-36 p-2">Screens</th>
              <th className="p-2">Status</th>
              <th className="p-2">Suggestion</th>
              <th className="p-2 text-center">Exclude</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={8} className="p-6 text-center text-slate-500">
                  Nothing in this view.
                </td>
              </tr>
            )}
            {shown.map((row) => {
              const problems = rowProblems(row);
              const values = valueProblems(row);
              const duplicate = isDuplicate(row);
              return (
                <tr
                  key={row.index}
                  className={cn(
                    "border-t align-top",
                    row.excluded && "opacity-50",
                  )}
                >
                  <td className="p-2 font-mono text-xs text-slate-500">
                    {row.index + 1}
                  </td>
                  <td className="p-2">
                    <Input
                      aria-label={`IBC#, row ${row.index + 1}`}
                      value={row.external_id}
                      disabled={duplicate}
                      aria-invalid={!row.excluded && !row.external_id.trim()}
                      onChange={(event) =>
                        patch(row.index, {
                          external_id: event.target.value.toUpperCase(),
                        })
                      }
                      className="h-8 w-28 font-mono"
                    />
                    {duplicate && (
                      <div
                        className="mt-1 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600"
                        role="note"
                      >
                        Duplicate: {duplicateText(row)}
                      </div>
                    )}
                  </td>
                  <td className="p-2">
                    <Input
                      aria-label={`Store name, row ${row.index + 1}`}
                      value={row.store_name}
                      aria-invalid={!row.excluded && !row.store_name.trim()}
                      onChange={(event) =>
                        patch(row.index, { store_name: event.target.value })
                      }
                      title={row.store_name}
                      className="h-8 w-56"
                    />
                  </td>
                  <td className="p-2">
                    <Input
                      aria-label={`Address, row ${row.index + 1}`}
                      defaultValue={row.address}
                      key={`${row.index}-${row.address}`}
                      onBlur={(event) =>
                        event.target.value !== row.address &&
                        verify(row, event.target.value)
                      }
                      className="h-8"
                    />
                    {row.formatted && row.status !== "validating" && (
                      <div
                        className="mt-1 truncate text-xs text-slate-500"
                        title={row.formatted}
                      >
                        → {row.formatted}
                      </div>
                    )}
                    {!row.excluded && problems.length > 0 && (
                      <div className="mt-1 text-xs text-rose-600">
                        {problems.join(" · ")}
                      </div>
                    )}
                    {values.length > 0 && (
                      <div className="mt-1 text-xs text-amber-700">
                        {values.join(" · ")}
                      </div>
                    )}
                    {row.error && row.status !== "valid" && (
                      <div className="text-xs text-amber-700">{row.error}</div>
                    )}
                    {!row.excluded &&
                      !duplicate &&
                      row.external_id.trim() &&
                      overridable(row).length > 0 && (
                        <label className="mt-1.5 flex w-fit cursor-pointer items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                          <Checkbox
                            aria-label={`Add anyway, row ${row.index + 1}`}
                            checked={Boolean(row.addAnyway)}
                            onCheckedChange={(checked) =>
                              patch(row.index, { addAnyway: checked === true })
                            }
                          />
                          Add anyway — marked as needing attention
                          {overridable(row).includes("address") &&
                            " (no map pin until the address is fixed)"}
                        </label>
                      )}
                  </td>
                  <td className="p-2 text-xs">
                    <div aria-label={`Screens, row ${row.index + 1}`}>
                      {screensPreview(row)}
                    </div>
                    <span
                      className={cn(
                        "mt-1 inline-flex rounded border px-1.5 py-0.5 text-[10px]",
                        STATUS_META[row.venue_status].chip,
                      )}
                      title={
                        row.venue_status_valid
                          ? undefined
                          : `"${row.venue_status_raw}" is not a known status; imported as Upcoming`
                      }
                    >
                      {STATUS_META[row.venue_status].label}
                      {!row.venue_status_valid && " ?"}
                    </span>
                  </td>
                  <td className="p-2">
                    <StatusChip row={row} />
                  </td>
                  <td className="space-y-1.5 p-2">
                    {row.suggestions.length > 0 && row.status !== "valid" && (
                      <Select onValueChange={(value) => verify(row, value)}>
                        <SelectTrigger
                          aria-label={`Suggestions, row ${row.index + 1}`}
                          className="h-8 w-56"
                        >
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
                    )}
                    <div className="flex flex-wrap items-center gap-1.5">
                      {row.status !== "valid" && !duplicate && (
                        <GoogleSearchPicker
                          address={row.address}
                          name={row.store_name}
                          label={`Search Google, row ${row.index + 1}`}
                          onPick={(hit) =>
                            onRowsChange((current) =>
                              current.map((r) =>
                                r.index === row.index ? applyPlace(r, hit) : r,
                              ),
                            )
                          }
                        />
                      )}
                      {row.previous && (
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-label={`Undo the pick, row ${row.index + 1}`}
                          title={`Back to: ${row.previous.address}`}
                          onClick={() =>
                            onRowsChange((current) =>
                              current.map((r) =>
                                r.index === row.index ? undoPick(r) : r,
                              ),
                            )
                          }
                        >
                          <Undo2 /> Undo
                        </Button>
                      )}
                      {row.status === "valid" && !row.previous && (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </div>
                  </td>
                  <td className="p-2 pt-3.5 text-center">
                    <Checkbox
                      aria-label={`Exclude row ${row.index + 1}`}
                      checked={row.excluded}
                      disabled={duplicate}
                      title={
                        duplicate ? "Duplicates are never imported" : undefined
                      }
                      onCheckedChange={(checked) =>
                        patch(row.index, { excluded: checked === true })
                      }
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
          <Button
            size="sm"
            variant="outline"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </Button>
          Page {page + 1} / {pages}
          <Button
            size="sm"
            variant="outline"
            disabled={page >= pages - 1}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      )}
      {(summary.blocked > 0 || summary.needsAttention > 0) && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {summary.needsAttention > 0 && (
            <span className="mr-auto inline-flex items-center gap-1 text-xs text-amber-800">
              <AlertTriangle className="size-3.5" /> {summary.needsAttention}{" "}
              stores will be added as needing attention
            </span>
          )}
          {summary.blocked > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="border-amber-300 text-amber-800"
              onClick={() =>
                onRowsChange((current) =>
                  current.map((row) =>
                    !row.excluded &&
                    rowProblems(row).length &&
                    row.external_id.trim() &&
                    !isDuplicate(row)
                      ? { ...row, addAnyway: true }
                      : row,
                  ),
                )
              }
            >
              Add the {summary.blocked} anyway (needs attention)
            </Button>
          )}
          {summary.blocked > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                onRowsChange((current) =>
                  current.map((row) =>
                    rowProblems(row).length ? { ...row, excluded: true } : row,
                  ),
                )
              }
            >
              Exclude the {summary.blocked} rows that still need fixing
            </Button>
          )}
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
  const label = {
    valid: "Valid",
    needs_review: row.coordinates_source === "sheet" ? "Sheet pin" : "Review",
    invalid: "Invalid",
  }[row.status];
  return (
    <span
      className={cn(
        "inline-flex rounded-full border px-2 py-0.5 font-mono text-[11px]",
        tone,
      )}
      title={row.verified_by.join(", ")}
    >
      {label} · {row.confidence}
    </span>
  );
}
