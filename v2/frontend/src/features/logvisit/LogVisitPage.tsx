import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MIN_QUERY, useVisitSearch } from "@/features/logvisit/api";
import { VisitPanel } from "@/features/visits/VisitPanel";
import type { ScreenStatus, VisitSearchRow } from "@/lib/api/types";
import { STATUS_META, storeStatusLabel } from "@/lib/status";
import { cn } from "@/lib/utils";

const DEBOUNCE_MS = 300;

const MATCH_LABEL: Record<VisitSearchRow["matched_on"][number], string> = {
  dd_code: "DD code",
  stick_number: "Stick number",
  store: "Name, ExtID or address",
};

function StatusChip({ status }: { status: string }) {
  const meta = STATUS_META[status as ScreenStatus];
  if (!meta) return status ? <span className="rounded-md border px-2 py-0.5 text-[11px] text-slate-600">{status}</span> : null;
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center rounded-md border px-2 text-[11px]", meta.chip)}>
      {storeStatusLabel(status as ScreenStatus)}
    </span>
  );
}

/** One store found: who it is, where, which project, and its screens with the one that matched picked out. */
function ResultRow({ row, onOpen }: { row: VisitSearchRow; onOpen: (row: VisitSearchRow, button: HTMLButtonElement) => void }) {
  const matched = new Set(row.matched_screen_ids);
  const address = [row.addr, row.city, [row.state, row.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const id = row.external_id || row.display_id;
  return (
    <li>
      <button
        type="button"
        onClick={(event) => onOpen(row, event.currentTarget)}
        aria-label={`Log a visit to ${row.store_name || "store"}${id ? ` (${id})` : ""}, ${row.project_name}`}
        className="group w-full rounded-xl border bg-white px-4 py-3 text-left shadow-sm outline-none transition-all hover:border-brand/60 hover:shadow-md focus-visible:border-brand focus-visible:ring-[3px] focus-visible:ring-brand/30"
      >
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-display text-xl leading-tight tracking-[1.5px] text-slate-900">{row.store_name || "Unnamed store"}</span>
              {id && <span className="font-mono text-xs text-slate-500">{id}</span>}
            </div>
            <div className="text-sm text-slate-600">{address || "No address"}</div>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] uppercase tracking-wider text-slate-500">{row.project_name}</span>
            <StatusChip status={row.status} />
          </div>
        </div>
        {row.screens.length > 0 && (
          <ul aria-label="Screens" className="mt-2 flex flex-wrap gap-1.5 font-mono text-[11px]">
            {row.screens.map((screen, index) => {
              const hit = matched.has(screen.id);
              return (
                <li
                  key={screen.id || index}
                  data-matched={hit || undefined}
                  className={cn("rounded-md border px-2 py-0.5", hit ? "border-brand bg-brand/10 text-brand" : "border-slate-200 bg-slate-50 text-slate-600")}
                >
                  {hit ? <mark className="bg-transparent font-bold text-brand">{screen.venue_id || "No DD code"}</mark> : screen.venue_id || "No DD code"}
                  {screen.stick_number && <span className="text-slate-400"> · {screen.stick_number}</span>}
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-400">
          Matched on {row.matched_on.map((kind) => MATCH_LABEL[kind]).join(", ")}
        </div>
      </button>
    </li>
  );
}

/** Log a visit to any store, found by a screen's DD code or by the store's address, without a project or route. */
export function LogVisitPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const [draft, setDraft] = useState(q);
  const [open, setOpen] = useState<{ projectId: string; stopUid: string } | null>(null);
  const lastOpened = useRef<HTMLButtonElement | null>(null);
  const search = useVisitSearch(q);

  // The address bar follows the box after a pause, so a reload or a shared link shows the same search.
  useEffect(() => {
    const next = draft.trim();
    if (next === q) return;
    const timer = window.setTimeout(() => setParams(next ? { q: next } : {}, { replace: true }), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, q, setParams]);

  const searching = q.length >= MIN_QUERY;
  const result = searching ? search.data : undefined;
  const pending = draft.trim() !== q || search.isFetching;

  return (
    <section className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 className="font-mono text-xs uppercase tracking-[3px] text-slate-500">Log visit</h1>
        <p className="mt-1 text-sm text-slate-600">Find a store in any project and log a visit to it.</p>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-slate-400" aria-hidden />
        <Input
          autoFocus
          type="search"
          aria-label="Search stores"
          placeholder="DD code, address, store name or ExtID"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="h-14 rounded-xl bg-white pr-24 pl-12 text-lg shadow-sm md:text-lg [&::-webkit-search-cancel-button]:hidden"
        />
        <div className="absolute top-1/2 right-3 flex -translate-y-1/2 items-center gap-1">
          {pending && searching && <Loader2 className="size-5 animate-spin text-slate-400" aria-label="Searching" />}
          {draft && (
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Clear search" onClick={() => { setDraft(""); setParams({}, { replace: true }); }}>
              <X />
            </Button>
          )}
        </div>
      </div>

      {!searching ? (
        <p className="text-sm text-slate-500">
          Type at least {MIN_QUERY} characters: a screen's DD code (whole or part, e.g. DD_ABC123 or ABC12), a stick number, or the store's street, city,
          state, ZIP, name or ExtID.
        </p>
      ) : search.isError ? (
        <Card className="p-6 text-center text-sm text-rose-700">Could not search: {search.error.message}</Card>
      ) : !result ? (
        <Card className="p-8 text-center font-mono text-sm text-slate-500">Searching…</Card>
      ) : result.items.length === 0 ? (
        <Card className="p-8 text-center text-sm text-slate-600">
          No store matches “{q}”. Check the DD code, or try fewer words of the address.
        </Card>
      ) : (
        <div className="space-y-2">
          <p className="font-mono text-[11px] uppercase tracking-wider text-slate-500" aria-live="polite">
            {result.total > result.items.length ? `Top ${result.items.length} of ${result.total} stores` : `${result.total} ${result.total === 1 ? "store" : "stores"}`}
          </p>
          <ul aria-label="Stores found" className={cn("space-y-2", pending && "opacity-70")}>
            {result.items.map((row) => (
              <ResultRow
                key={`${row.project_id}/${row.uid}`}
                row={row}
                onOpen={(chosen, button) => {
                  lastOpened.current = button;
                  setOpen({ projectId: chosen.project_id, stopUid: chosen.uid });
                }}
              />
            ))}
          </ul>
          {result.total > result.items.length && (
            <p className="text-center text-sm text-slate-500">More stores match. Refine your search to narrow the list.</p>
          )}
        </div>
      )}

      <VisitPanel
        projectId={open?.projectId ?? null}
        stopUid={open?.stopUid ?? null}
        onClose={() => {
          setOpen(null);
          window.setTimeout(() => lastOpened.current?.focus(), 0); // back on the store just logged, ready for the next
        }}
      />
    </section>
  );
}
