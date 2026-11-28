import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Clock, Loader2, MapPin, MapPinOff, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DEVICE_TONE, DeviceBadge, REPORT_STATUS_TONE, reportDay } from "@/features/device/DeviceBits";
import { useAddReviewed, useAddReviewedMany, useDeviceReview, useSnoozeReviewed, useSnoozeReviewedMany } from "@/features/device/api";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GoogleSearchPicker } from "@/features/places/GoogleSearchPicker";
import { OtherPaSection } from "@/features/device/OtherPaSection";
import { ApiError, type Project, type ProjectSummary, type ReviewAdd, type ReviewItem } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const PAGE = 25;

/** Report records of the project's PA whose DD code is in no store: add each as a store, or "Not now" (it comes
 *  back with the next report day). On a second tab, screens of another PA at our addresses, for a check only. */
export function ReviewDialog({
  project,
  open,
  onClose,
  onMissingScreens,
  onOpenStore,
  search = "",
}: {
  project: Project & { kpi?: ProjectSummary["kpi"] };
  open: boolean;
  onClose: () => void;
  /** Show the done stores that have fewer screens than the sheet committed. */
  onMissingScreens?: () => void;
  /** Open one of the project's stores (from the screens of another PA at its address). */
  onOpenStore?: (uid: string) => void;
  /** What the list starts narrowed to (the Stores search, when it found records waiting here). */
  search?: string;
}) {
  const missing = project.kpi?.review_screens ?? 0;
  const newCount = project.device_sync?.review_count ?? 0;
  const otherCount = project.device_sync?.other_pa_count ?? 0;
  // Two lists, one tab each, so neither has to be scrolled past to reach the other.
  const [tab, setTab] = useState<"new" | "other">("new");
  useEffect(() => {
    if (open) setTab(newCount === 0 && otherCount > 0 && !search ? "other" : "new"); // start where there is something
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [includeSnoozed, setIncludeSnoozed] = useState(false);
  const [query, setQuery] = useState(search);
  useEffect(() => {
    if (!open) return;
    setQuery(search); // each opening starts from what it was opened for
    setCursors([null]);
  }, [open, search]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const review = useDeviceReview(project.id, { limit: PAGE, cursor }, includeSnoozed, open, query);
  const add = useAddReviewed(project.id);
  const snooze = useSnoozeReviewed(project.id);
  const page = review.data;
  const start = (cursors.length - 1) * PAGE;
  const date = project.device_sync?.snapshot_date ?? "";

  // Rows whose address Google could not verify (or the report lacks): the address step, as on import.
  const [fixing, setFixing] = useState<Record<string, AddressStep>>({});
  const onAdd = (item: ReviewItem, body: Partial<ReviewAdd> = {}) =>
    add.mutate(
      { key: item.key, body },
      {
        onSuccess: (stop) => {
          setFixing(({ [item.key]: _done, ...rest }) => rest);
          setSelected(({ [item.key]: _added, ...rest }) => rest); // added: nothing left to add for it
          toast.success(
            stop.needs_attention.includes("address")
              ? `${stop.store_name || item.venue_id} added without a verified address; it needs attention`
              : `${stop.store_name} ${stop.screens.length > 1 ? `has a new screen (${item.venue_id})` : "added"}`,
          );
        },
        onError: (error) => {
          const detail = error instanceof ApiError ? error.validation : null;
          if (detail?.suggestions !== undefined) {
            const typed = body.address ?? fixing[item.key]?.typed ?? detail.address ?? "";
            setFixing((all) => ({ ...all, [item.key]: { message: detail.message, suggestions: detail.suggestions ?? [], typed } }));
          } else toast.error(error instanceof Error ? error.message : "Could not add");
        },
      },
    );
  const onSnooze = (item: ReviewItem) =>
    snooze.mutate(item.key, {
      onSuccess: () => setSelected(({ [item.key]: _hidden, ...rest }) => rest),
      onError: (error) => toast.error(error instanceof Error ? error.message : "Could not hide"),
    });

  // Several at once: tick rows (they stay ticked across pages), then add or set them all aside.
  // A row whose address step is open is dealt with there (check, pick, or add anyway): it is not ticked, so
  // "Add N selected" never counts, or retries, a row that can only fail the same way again.
  const [selected, setSelected] = useState<Record<string, ReviewItem>>({});
  const chosen = Object.values(selected).filter((item) => !fixing[item.key]);
  const addMany = useAddReviewedMany(project.id);
  const snoozeMany = useSnoozeReviewedMany(project.id);
  const busy = add.isPending || snooze.isPending || addMany.isPending || snoozeMany.isPending;
  const pageItems = (page?.items ?? []).filter((item) => !item.snoozed_date && !fixing[item.key]);
  const allTicked = pageItems.length > 0 && pageItems.every((item) => selected[item.key]);
  const tick = (items: ReviewItem[], on: boolean) =>
    setSelected((all) => {
      const next = { ...all };
      for (const item of items) {
        if (on) next[item.key] = item;
        else delete next[item.key];
      }
      return next;
    });
  const onAddSelected = () =>
    addMany.mutate(chosen.map((item) => item.key), {
      onSuccess: (results) => {
        const failed = results.filter((result) => result.error);
        // The ones Google could not verify open their address step and leave the selection; the rest are in.
        setFixing((all) => {
          const next = { ...all };
          for (const { key, error } of failed) {
            const detail = error instanceof ApiError ? error.validation : null;
            if (detail?.suggestions !== undefined) next[key] = { message: detail.message, suggestions: detail.suggestions ?? [], typed: detail.address ?? "" };
          }
          return next;
        });
        // Kept ticked: only a row that failed for another reason (a network error), so it can be tried again.
        setSelected((all) =>
          Object.fromEntries(
            failed.flatMap(({ key, error }) => {
              const needsAddress = error instanceof ApiError && error.validation?.suggestions !== undefined;
              return all[key] && !needsAddress ? [[key, all[key]]] : [];
            }),
          ),
        );
        const added = results.length - failed.length;
        if (added) toast.success(`${added} ${added === 1 ? "screen" : "screens"} added`);
        if (failed.length) toast.error(`${failed.length} could not be added: check ${failed.length === 1 ? "its address" : "their addresses"} below`);
      },
    });
  const onSnoozeSelected = () =>
    snoozeMany.mutate(chosen.map((item) => item.key), {
      onSuccess: () => setSelected({}),
      onError: (error) => toast.error(error instanceof Error ? error.message : "Could not hide"),
    });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex h-[90vh] w-[92vw] max-w-[92vw] flex-col gap-3 sm:max-w-[92vw]">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            Needs review {date && <DeviceBadge date={date} />}
          </DialogTitle>
          <DialogDescription>
            What the CMS data has that this project does not: screens of {project.device_pa} in no store here, and screens of
            another PA at our addresses.
          </DialogDescription>
        </DialogHeader>
        {missing > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-cyan-50 px-3 py-2 text-sm text-cyan-900" role="status">
            <span className="min-w-0 flex-1">
              <span className="font-semibold">{missing.toLocaleString()} committed screens</span> are missing at {(project.kpi?.review_stores ?? 0).toLocaleString()} stores
              that read as done (Completed or Offline, with fewer screens than the sheet committed).
            </span>
            {onMissingScreens && (
              <Button size="sm" variant="outline" onClick={onMissingScreens}>
                Show these stores
              </Button>
            )}
          </div>
        )}
        <Tabs value={tab} onValueChange={(value) => setTab(value as "new" | "other")} className="min-h-0 flex-1 gap-3">
        <TabsList aria-label="What to review">
          <TabsTrigger value="new" className="gap-1.5 px-3">
            New screens of {project.device_pa} <TabCount value={newCount} />
          </TabsTrigger>
          <TabsTrigger value="other" className="gap-1.5 px-3">
            Screens from another PA at our addresses <TabCount value={otherCount} />
          </TabsTrigger>
        </TabsList>
        <TabsContent value="new" className="flex min-h-0 flex-1 flex-col gap-3">
        <p className="text-sm text-slate-600">
          Their DD code is in no store of this project. Add creates the store from the report; Not now hides it until the next report day.
        </p>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Input
            type="search"
            aria-label="Search the records to review"
            placeholder="Search ExtID, name, DD code, address"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursors([null]);
            }}
            className="h-8 w-72"
          />
          <label className="flex items-center gap-1.5">
            <Checkbox
              checked={includeSnoozed}
              onCheckedChange={(checked) => {
                setIncludeSnoozed(checked === true);
                setCursors([null]);
              }}
            />
            Show the ones set to Not now{page ? ` (${page.snoozed})` : ""}
          </label>
          {review.isFetching && <Loader2 className="size-4 animate-spin text-slate-400" />}
        </div>
        {/* Select all on this page; with rows ticked, the two actions for all of them. */}
        <div className="flex min-h-9 flex-wrap items-center gap-2 text-sm" role="toolbar" aria-label="Selected screens">
          <label className="flex items-center gap-1.5">
            <Checkbox aria-label="Select all on this page" checked={allTicked} disabled={pageItems.length === 0} onCheckedChange={(checked) => tick(pageItems, checked === true)} />
            {chosen.length > 0 ? `${chosen.length} selected` : "Select all on this page"}
          </label>
          {chosen.length > 0 && (
            <>
              <Button size="sm" variant="ghost" onClick={() => setSelected({})} disabled={busy}>
                Clear
              </Button>
              <span className="ml-auto flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={onSnoozeSelected} disabled={busy}>
                  {snoozeMany.isPending ? <Loader2 className="animate-spin" /> : <Clock />} Not now for {chosen.length}
                </Button>
                <Button size="sm" onClick={onAddSelected} disabled={busy}>
                  {addMany.isPending ? <Loader2 className="animate-spin" /> : <Plus />} Add {chosen.length} selected
                </Button>
              </span>
            </>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border">
          {review.isError && <p className="p-4 text-sm text-rose-700">{review.error.message}</p>}
          {page && page.items.length === 0 && <p className="p-6 text-center text-sm text-slate-500">{query.trim() ? "No record to review matches the search." : "Nothing to review."}</p>}
          <ul className="divide-y">
            {page?.items.map((item) => (
              <li key={item.key} className={cn("flex flex-wrap items-center gap-3 px-3 py-2.5", item.snoozed_date && "opacity-60", selected[item.key] && !fixing[item.key] && "bg-sky-50/60")}>
                <Checkbox
                  aria-label={`Select ${item.venue_id}`}
                  checked={Boolean(selected[item.key]) && !fixing[item.key]}
                  disabled={Boolean(item.snoozed_date) || Boolean(fixing[item.key])}
                  title={fixing[item.key] ? "Fix its address below, or add it anyway" : undefined}
                  onCheckedChange={(checked) => tick([item], checked === true)}
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span className={DEVICE_TONE.text}>{item.store_name || item.venue_name || "No name in the report"}</span>
                    <span className="font-mono text-xs text-slate-500">{item.venue_id}</span>
                    <span className={cn("rounded border px-1 text-[11px]", STATUS_TONE[item.status.toLowerCase()] ?? "text-slate-600")}>{item.status || "Unknown"}</span>
                    {item.snoozed_date && (
                      <span className="flex items-center gap-0.5 text-[11px] text-slate-500">
                        <Clock size={11} /> Not now until after {reportDay(item.snoozed_date)}
                      </span>
                    )}
                  </p>
                  <p className="flex items-center gap-1 text-sm text-slate-700">
                    {item.lat === null ? (
                      <MapPinOff size={13} className="shrink-0 text-amber-600" aria-label="No location in the report" />
                    ) : (
                      <MapPin size={13} className="shrink-0 text-slate-400" aria-hidden />
                    )}
                    <span className="truncate">{item.address || [item.city, item.state, item.zip].filter(Boolean).join(", ") || "No address in the report"}</span>
                  </p>
                  {/* What else the report knows, each under its name. It has no screen size: that is set in the store. */}
                  <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs" aria-label={`Details of ${item.venue_id}`}>
                    <Fact label="DMA" value={item.dma} />
                    <Fact label="Venue type" value={item.venue_type} />
                    <Fact
                      label="Registered"
                      value={day(item.last_registered) || day(item.first_registered)}
                      title={`First registered ${day(item.first_registered) || "—"} · last registered ${day(item.last_registered) || "—"}`}
                      empty="Never"
                    />
                    <Fact label="Last seen" value={day(item.last_seen)} />
                    <Fact label="Stick #" value={item.serial_number} mono />
                    <Fact label="ExtID" value={item.external_id} mono />
                    <Fact label="CMS name" value={item.venue_name} mono />
                  </dl>
                </div>
                <Button size="sm" variant="ghost" onClick={() => onSnooze(item)} disabled={busy || Boolean(item.snoozed_date)}>
                  <Clock /> Not now
                </Button>
                <Button size="sm" onClick={() => onAdd(item)} disabled={busy}>
                  {add.isPending && add.variables?.key === item.key ? <Loader2 className="animate-spin" /> : <Plus />} Add
                </Button>
                {fixing[item.key] && (
                  <AddressFix
                    item={item}
                    step={fixing[item.key]!}
                    busy={add.isPending}
                    onType={(typed) => setFixing((all) => ({ ...all, [item.key]: { ...all[item.key]!, typed } }))}
                    onSubmit={(body) => onAdd(item, body)}
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
        {page && page.total > PAGE && (
          <div className="flex items-center justify-end gap-2 text-sm text-slate-600">
            <span>
              {start + 1}–{Math.min(start + PAGE, page.total)} of {page.total}
            </span>
            <Button size="icon" variant="outline" aria-label="Previous page" disabled={cursors.length === 1} onClick={() => setCursors((all) => all.slice(0, -1))}>
              <ChevronLeft />
            </Button>
            <Button size="icon" variant="outline" aria-label="Next page" disabled={!page.next_cursor} onClick={() => setCursors((all) => [...all, page.next_cursor])}>
              <ChevronRight />
            </Button>
          </div>
        )}
        </TabsContent>
        <TabsContent value="other" className="flex min-h-0 flex-1 flex-col">
          <OtherPaSection projectId={project.id} open={open} onOpenStore={onOpenStore} />
        </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

const day = (iso: string) => (iso ?? "").slice(0, 10);
const STATUS_TONE = REPORT_STATUS_TONE;

/** One labelled value of a report record; a dash when the report has none. */
/** How many rows a tab holds; quiet at 0. */
function TabCount({ value }: { value: number }) {
  return (
    <span className={cn("rounded-full px-1.5 text-xs tabular-nums", value > 0 ? "bg-cyan-100 text-cyan-900" : "bg-slate-200 text-slate-500")}>
      {value.toLocaleString()}
    </span>
  );
}

function Fact({ label, value, title, empty = "—", mono = false }: { label: string; value: string; title?: string; empty?: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5" title={title}>
      <dt className="font-mono text-[10px] uppercase tracking-wider text-slate-400">{label}</dt>
      <dd className={cn(value ? "text-slate-800" : "text-slate-400", mono && "font-mono")}>{value || empty}</dd>
    </div>
  );
}

interface AddressStep {
  message: string;
  suggestions: string[];
  typed: string;
}

/** The import's address check for one record: type and check, pick Google's suggestion or a place from a Google
 *  search (by the store name when the report has no address), or add it anyway (flagged for attention). */
function AddressFix({ item, step, busy, onType, onSubmit }: {
  item: ReviewItem;
  step: AddressStep;
  busy: boolean;
  onType: (typed: string) => void;
  onSubmit: (body: Partial<ReviewAdd>) => void;
}) {
  const name = item.store_name || item.venue_name;
  const searchFor = step.typed.trim() || [item.city, item.state].filter(Boolean).join(", ") || name;
  return (
    <div role="alert" className="basis-full space-y-2 rounded-md border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800">
      <p>{step.message}</p>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (step.typed.trim()) onSubmit({ address: step.typed.trim() });
        }}
      >
        <Input
          aria-label={`Address for ${item.venue_id}`}
          placeholder="Street, city, state ZIP"
          value={step.typed}
          onChange={(event) => onType(event.target.value)}
          className="h-8 bg-white"
        />
        <Button type="submit" size="sm" variant="outline" disabled={busy || !step.typed.trim()}>
          Check address
        </Button>
      </form>
      {step.suggestions.length > 0 && (
        <ul className="space-y-1">
          {step.suggestions.map((suggestion) => (
            <li key={suggestion}>
              <button type="button" className="text-left text-brand underline-offset-2 hover:underline" onClick={() => onSubmit({ address: suggestion })}>
                {suggestion}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-rose-200 pt-2 text-xs">
        <GoogleSearchPicker address={searchFor} name={name} label={`Search Google for ${item.venue_id}`} onPick={(hit) => onSubmit({ place: hit })} />
        <Button size="xs" variant="ghost" className="ml-auto" disabled={busy} onClick={() => onSubmit({ add_anyway: true })}>
          Add anyway (needs attention)
        </Button>
      </div>
    </div>
  );
}
