import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SectionTitle } from "@/features/settings/DetailsSection";
import { money } from "@/features/stores/details";
import { keys } from "@/lib/api/keys";
import { screenSheetApi } from "@/lib/api/resources";
import type { Project, ScreenSheetResult, SheetScreenRow } from "@/lib/api/types";
import { cn } from "@/lib/utils";

/** The file as base64, read in the browser (the sheet is small: one row per screen). */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? ""); // "data:…;base64,<content>"
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read"));
    reader.readAsDataURL(file);
  });
}

const owner = (dolphin: boolean | null | undefined) => (dolphin === null || dolphin === undefined ? "—" : dolphin ? "Dolphin" : "Store");
type Show = "changes" | "costs" | "unmatched" | "all";

/** The screen cost sheet: one row per DD code with the screen's size, the screen count (0 = the store's own TV, a
 *  stick only) and the cost. Upload shows what it would change first; Apply then sets the size and who each screen
 *  belongs to. The sheet's cost is only checked against the prices above, never saved: costs come from the prices. */
export function ScreenSheetSection({ project }: { project: Project }) {
  const input = useRef<HTMLInputElement>(null);
  const client = useQueryClient();
  const [sheet, setSheet] = useState<{ filename: string; content_base64: string } | null>(null);
  const [result, setResult] = useState<ScreenSheetResult | null>(null);
  const [show, setShow] = useState<Show>("changes");
  const send = useMutation({
    mutationFn: (body: { filename: string; content_base64: string; apply: boolean }) => screenSheetApi.send(project.id, body),
    onSuccess: (next) => {
      setResult(next);
      void client.invalidateQueries({ queryKey: keys.projectUploads(project.id) }); // the sheet is kept: list it
      if (next.applied) {
        toast.success(`${next.screens_updated} ${next.screens_updated === 1 ? "screen" : "screens"} updated from the sheet`);
        void client.invalidateQueries({ queryKey: keys.project(project.id) });
      } else setShow(next.changing ? "changes" : next.cost_differs ? "costs" : next.unmatched ? "unmatched" : "all");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not read the sheet"),
  });
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    let content = "";
    try {
      content = await toBase64(file);
    } catch (error) {
      return void toast.error(error instanceof Error ? error.message : "The file could not be read");
    }
    const next = { filename: file.name, content_base64: content };
    setSheet(next);
    setResult(null);
    send.mutate({ ...next, apply: false });
  };
  const rows = result?.rows ?? [];
  // A cost column on the sheet is optional: without one there is nothing to compare, only the worked-out cost.
  const sheetHasCost = rows.some((row) => row.sheet_cost !== null && row.sheet_cost !== undefined);
  const shown = rows.filter((row) => (show === "changes" ? row.changes : show === "costs" ? row.cost_differs : show === "unmatched" ? !row.matched : true));
  const tabs: [Show, string, number][] = result
    ? ([["changes", "To change", result.changing], ["costs", "Cost differs", result.cost_differs], ["unmatched", "Not in the project", result.unmatched], ["all", "All rows", rows.length]] as [Show, string, number][]).filter(
        ([key]) => key !== "costs" || sheetHasCost,
      )
    : [];
  const head = "px-2 py-1.5 text-left font-mono text-[11px] font-normal uppercase tracking-wider text-slate-500";
  return (
    <Card className="gap-4 p-5" aria-label="Screen cost sheet">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionTitle
          title="Screen cost sheet"
          hint="Every sheet uploaded here is kept under Uploaded sheets. A sheet with one row per DD code: Venue ID, Stick Count, Screen Size and Screen Count. It sets each matching screen's size and whether it is a Dolphin screen (Screen Count 1) or the store's own TV (0: the stick only). The cost is worked out from those counts and the prices in Hardware costs. Nothing is saved until you press Apply."
        />
        <input ref={input} type="file" accept=".csv,.xlsx" className="hidden" aria-label="Screen cost sheet file" onChange={(event) => void onFile(event.target.files?.[0]).finally(() => (event.target.value = ""))} />
        <Button onClick={() => input.current?.click()} disabled={send.isPending}>
          {send.isPending && !send.variables?.apply ? <Loader2 className="animate-spin" /> : <Upload />} Upload cost sheet
        </Button>
      </div>
      {result && sheet && (
        <>
          <p className="text-sm text-slate-700" role="status">
            <span className="font-medium text-slate-900">{sheet.filename}</span>: {result.matched} of {rows.length} rows match a screen · {result.changing} to change · {result.unmatched} not in the project
            {sheetHasCost && ` · ${result.cost_differs} where the cost differs from our prices`} · worked-out cost{" "}
            <span className="font-semibold text-slate-900" aria-label="Worked-out cost">
              {money(result.total_cost)}
            </span>
            {result.unpriced > 0 && <span className="text-amber-700"> ({result.unpriced} rows have no price in Hardware costs)</span>}
            {result.applied && (
              <span className="ml-2 inline-flex items-center gap-1 font-medium text-green-700">
                <Check size={14} /> applied
              </span>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Rows shown">
            {tabs.map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={show === key}
                onClick={() => setShow(key)}
                className={cn("rounded-full border px-2.5 py-1 text-xs font-medium", show === key ? "border-brand bg-brand text-white" : "bg-white text-slate-600 hover:bg-slate-50")}
              >
                {label} {count}
              </button>
            ))}
            <Button className="ml-auto" size="sm" disabled={send.isPending || result.changing === 0} onClick={() => send.mutate({ ...sheet, apply: true })}>
              {send.isPending && send.variables?.apply && <Loader2 className="animate-spin" />} Apply {result.changing} {result.changing === 1 ? "change" : "changes"}
            </Button>
          </div>
          {shown.length === 0 ? (
            <p className="text-sm text-slate-500">No rows here.</p>
          ) : (
            <div className="max-h-96 overflow-auto rounded-lg border">
              <table className="w-full text-sm" aria-label="Sheet rows">
                <thead className="sticky top-0 border-b bg-slate-50">
                  <tr>
                    <th className={head}>Row</th>
                    <th className={head}>DD code</th>
                    <th className={head}>Store</th>
                    <th className={head}>Size</th>
                    <th className={head}>Belongs to</th>
                    <th className={head}>Sticks</th>
                    <th className={head}>Screens</th>
                    {sheetHasCost && <th className={head}>Sheet cost</th>}
                    <th className={head}>Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {shown.map((row) => (
                    <SheetRow key={`${row.row}-${row.dd_code}`} row={row} sheetHasCost={sheetHasCost} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/** A value before → after; just the value when it does not change. */
function Change({ from, to }: { from: string; to: string }) {
  if (from === to) return <span className="text-slate-700">{to || "—"}</span>;
  return (
    <span className="whitespace-nowrap">
      <span className="text-slate-400 line-through">{from || "—"}</span> → <span className="font-semibold text-slate-900">{to || "—"}</span>
    </span>
  );
}

function SheetRow({ row, sheetHasCost }: { row: SheetScreenRow; sheetHasCost: boolean }) {
  const cost = (value: number | null | undefined) => (value === null || value === undefined ? <span className="text-slate-300">—</span> : money(value));
  return (
    <tr aria-label={row.dd_code} className={cn(!row.matched && "bg-slate-50/60 text-slate-500")}>
      <td className="px-2 py-1.5 font-mono text-xs text-slate-500">{row.row}</td>
      <td className="whitespace-nowrap px-2 py-1.5 font-mono text-xs">{row.dd_code}</td>
      <td className="px-2 py-1.5">
        {row.matched ? (
          <span className="flex items-center gap-1.5">
            <span className="truncate">{row.store_name || row.store_external_id}</span>
            {row.ibc_differs && (
              <span className="inline-flex shrink-0 items-center gap-1 text-xs text-amber-700" title={`The sheet says ${row.external_id}; this DD code is at ${row.store_external_id}`}>
                <AlertTriangle size={12} /> ExtID {row.external_id}
              </span>
            )}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-amber-700">
            <AlertTriangle size={12} /> {row.problem}
          </span>
        )}
      </td>
      <td className="px-2 py-1.5 font-mono text-xs">{row.matched ? <Change from={row.size_from ?? ""} to={row.size_to ?? ""} /> : row.size_to || "—"}</td>
      <td className="px-2 py-1.5 text-xs">{row.matched ? <Change from={owner(row.dolphin_from)} to={owner(row.dolphin_to)} /> : "—"}</td>
      <td className="px-2 py-1.5 font-mono text-xs tabular-nums">{row.stick_count}</td>
      <td className="px-2 py-1.5 font-mono text-xs tabular-nums">{row.screen_count ?? <span className="text-slate-300">—</span>}</td>
      {sheetHasCost && (
        <td className="px-2 py-1.5 font-mono text-xs tabular-nums" title={row.note || undefined}>
          {cost(row.sheet_cost)}
        </td>
      )}
      <td
        className={cn("px-2 py-1.5 font-mono text-xs tabular-nums", row.cost_differs && "font-semibold text-amber-700")}
        title={row.cost_differs ? "The sheet's cost is not what our prices give for these counts and this size" : "Sticks × the stick price + Dolphin screens × the price of this size"}
      >
        {!row.matched ? "—" : row.our_cost === null || row.our_cost === undefined ? <span className="text-amber-700">no price</span> : money(row.our_cost)}
      </td>
    </tr>
  );
}
