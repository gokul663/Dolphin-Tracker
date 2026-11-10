import { useState } from "react";
import { ChevronLeft, ChevronRight, Clock, Loader2, MapPinOff, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DEVICE_TONE, DeviceBadge, reportDay } from "@/features/device/DeviceBits";
import { useAddReviewed, useDeviceReview, useSnoozeReviewed } from "@/features/device/api";
import { Input } from "@/components/ui/input";
import { GoogleSearchPicker } from "@/features/places/GoogleSearchPicker";
import { ApiError, type Project, type ReviewAdd, type ReviewItem } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const PAGE = 25;

/** Report records of the project's PA whose DD code is in no store: add each as a store, or "Not now" (it comes
 *  back with the next report day). */
export function ReviewDialog({ project, open, onClose }: { project: Project; open: boolean; onClose: () => void }) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [includeSnoozed, setIncludeSnoozed] = useState(false);
  const cursor = cursors[cursors.length - 1] ?? null;
  const review = useDeviceReview(project.id, { limit: PAGE, cursor }, includeSnoozed, open);
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
    snooze.mutate(item.key, { onError: (error) => toast.error(error instanceof Error ? error.message : "Could not hide") });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[88vh] flex-col gap-3 sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            Needs review {date && <DeviceBadge date={date} />}
          </DialogTitle>
          <DialogDescription>
            Screens the CMS reports for {project.device_pa} whose DD code is in no store of this project. Add creates the store from the
            report; Not now hides it until the next report day.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 text-sm">
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
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border">
          {review.isError && <p className="p-4 text-sm text-rose-700">{review.error.message}</p>}
          {page && page.items.length === 0 && <p className="p-6 text-center text-sm text-slate-500">Nothing to review.</p>}
          <ul className="divide-y">
            {page?.items.map((item) => (
              <li key={item.key} className={cn("flex flex-wrap items-center gap-3 px-3 py-2", item.snoozed_date && "opacity-60")}>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span className={DEVICE_TONE.text}>{item.store_name || item.venue_name || "No name in the report"}</span>
                    <span className="font-mono text-xs text-slate-500">{item.venue_id}</span>
                    <span className="rounded border px-1 text-[11px] text-slate-600">{item.status || "Unknown"}</span>
                    {item.snoozed_date && (
                      <span className="flex items-center gap-0.5 text-[11px] text-slate-500">
                        <Clock size={11} /> Not now until after {reportDay(item.snoozed_date)}
                      </span>
                    )}
                  </p>
                  <p className="flex items-center gap-1 truncate text-xs text-slate-600">
                    {item.lat === null && <MapPinOff size={11} className="shrink-0 text-amber-600" aria-label="No location in the report" />}
                    {item.address || [item.city, item.state, item.zip].filter(Boolean).join(", ") || "No address in the report"}
                    {item.venue_name && <span className="ml-1 font-mono text-slate-400">· {item.venue_name}</span>}
                  </p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => onSnooze(item)} disabled={snooze.isPending || Boolean(item.snoozed_date)}>
                  <Clock /> Not now
                </Button>
                <Button size="sm" onClick={() => onAdd(item)} disabled={add.isPending}>
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
      </DialogContent>
    </Dialog>
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
