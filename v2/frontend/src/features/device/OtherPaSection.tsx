import { useEffect, useState } from "react";
import { ArrowRight, Check, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { REPORT_STATUS_TONE } from "@/features/device/DeviceBits";
import { useOtherPaReviewed, useOtherPaScreens } from "@/features/device/api";
import { useCan } from "@/lib/auth/me";
import type { OtherPaScreen } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const PAGE = 25;

/** Needs review's second list: screens the CMS has at one of our stores' addresses under another PA, or none (an
 *  ATM screen at the store, say). Never added from here; "Reviewed, it's fine" hides one until its PA or our store
 *  changes. Nothing shows while there is none. */
export function OtherPaSection({ projectId, open, onOpenStore }: {
  projectId: string;
  open: boolean;
  /** Open our store (closes the dialog). */
  onOpenStore?: (uid: string) => void;
}) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [selected, setSelected] = useState<Record<string, true>>({});
  useEffect(() => {
    if (!open) return;
    setCursors([null]);
    setSelected({});
  }, [open]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const list = useOtherPaScreens(projectId, { limit: PAGE, cursor }, open);
  const reviewed = useOtherPaReviewed(projectId);
  const canEdit = useCan("projects.edit");
  const page = list.data;
  const items = page?.items ?? [];
  // The last row of a later page marked reviewed: back a page rather than an empty one.
  useEffect(() => {
    if (page && items.length === 0 && cursors.length > 1) setCursors((all) => all.slice(0, -1));
  }, [page, items.length, cursors.length]);
  if (!page) return <p className="p-6 text-center text-sm text-slate-500">Loading…</p>;
  if (page.total === 0) return <p className="p-6 text-center text-sm text-slate-500">No screen from another PA at our addresses.</p>;

  const start = (cursors.length - 1) * PAGE;
  const chosen = Object.keys(selected);
  const allTicked = items.length > 0 && items.every((item) => selected[item.key]);
  const tick = (rows: OtherPaScreen[], on: boolean) =>
    setSelected((all) => {
      const next = { ...all };
      for (const row of rows) {
        if (on) next[row.key] = true;
        else delete next[row.key];
      }
      return next;
    });
  const markReviewed = (keys: string[]) =>
    reviewed.mutate(keys, {
      onSuccess: () => setSelected((all) => Object.fromEntries(Object.keys(all).filter((key) => !keys.includes(key)).map((key) => [key, true as const]))),
      onError: (error) => toast.error(error instanceof Error ? error.message : "Could not mark reviewed"),
    });

  return (
    <section aria-labelledby="other-pa-title" className="flex min-h-0 flex-1 flex-col gap-2">
      <div>
        <h3 id="other-pa-title" className="text-sm font-semibold text-slate-900">
          Screens from another PA at our addresses <span className="font-normal text-slate-500">({page.total.toLocaleString()})</span>
        </h3>
        <p className="text-sm text-slate-600">These are not added to the project. If one is wrong, fix it in the CMS.</p>
      </div>
      {canEdit && (
        <div className="flex min-h-8 flex-wrap items-center gap-2 text-sm" role="toolbar" aria-label="Selected screens from another PA">
          <label className="flex items-center gap-1.5">
            <Checkbox aria-label="Select all screens from another PA on this page" checked={allTicked} onCheckedChange={(checked) => tick(items, checked === true)} />
            {chosen.length > 0 ? `${chosen.length} selected` : "Select all on this page"}
          </label>
          {chosen.length > 0 && (
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => markReviewed(chosen)} disabled={reviewed.isPending}>
              {reviewed.isPending ? <Loader2 className="animate-spin" /> : <Check />} Reviewed, it's fine for {chosen.length}
            </Button>
          )}
        </div>
      )}
      <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border">
        {items.map((item) => (
          <li key={item.key} className={cn("flex flex-wrap items-center gap-3 px-3 py-2", selected[item.key] && "bg-sky-50/60")}>
            {canEdit && <Checkbox aria-label={`Select ${item.venue_id} at ${item.store_name || item.external_id}`} checked={Boolean(selected[item.key])} onCheckedChange={(checked) => tick([item], checked === true)} />}
            <div className="min-w-0 flex-1 basis-56 text-sm">
              {onOpenStore ? (
                <button type="button" className="font-medium text-brand underline-offset-2 hover:underline" onClick={() => onOpenStore(item.stop_uid)}>
                  {item.store_name || "No name"}
                </button>
              ) : (
                <span className="font-medium">{item.store_name || "No name"}</span>
              )}{" "}
              {item.external_id && <span className="font-mono text-xs text-slate-500">{item.external_id}</span>}
              <p className="truncate text-slate-600">{item.address || "No address"}</p>
            </div>
            <ArrowRight size={14} className="shrink-0 text-slate-300" aria-hidden />
            <div className="min-w-0 flex-1 basis-56 space-y-0.5 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-slate-700">{item.venue_id}</span>
                <span className={cn("rounded border px-1 text-[11px]", item.pa_name ? "text-slate-700" : "border-amber-300 text-amber-700")}>{item.pa_name || "No PA"}</span>
                <span className={cn("rounded border px-1 text-[11px]", REPORT_STATUS_TONE[item.status.toLowerCase()] ?? "text-slate-600")}>{item.status || "Unknown"}</span>
              </p>
              <p className="truncate font-mono text-xs text-slate-500" title="Its name in the CMS">{item.venue_name || "No name in the CMS"}</p>
            </div>
            {canEdit && (
              <Button size="sm" variant="ghost" onClick={() => markReviewed([item.key])} disabled={reviewed.isPending} aria-label={`Reviewed, it's fine: ${item.venue_id}`}>
                <Check /> Reviewed, it's fine
              </Button>
            )}
          </li>
        ))}
      </ul>
      {page.total > PAGE && (
        <div className="flex items-center justify-end gap-2 text-sm text-slate-600">
          <span>
            {start + 1}–{Math.min(start + PAGE, page.total)} of {page.total}
          </span>
          <Button size="icon" variant="outline" aria-label="Previous page of screens from another PA" disabled={cursors.length === 1} onClick={() => setCursors((all) => all.slice(0, -1))}>
            <ChevronLeft />
          </Button>
          <Button size="icon" variant="outline" aria-label="Next page of screens from another PA" disabled={!page.next_cursor} onClick={() => setCursors((all) => [...all, page.next_cursor])}>
            <ChevronRight />
          </Button>
        </div>
      )}
    </section>
  );
}
