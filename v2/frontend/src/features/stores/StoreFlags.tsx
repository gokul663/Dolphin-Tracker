import { CircleSlash, Loader2, Tag, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useIgnoreMismatch, useSetStoreTag } from "@/features/stores/api";
import { useCan } from "@/lib/auth/me";
import type { Project, Stop } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { tagChip, tagTone } from "@/features/stores/tagTone";

/** Radix Select has no empty value: "No tag" goes through this. */
const NONE = "__none__";

/** The project manager's tag on a store, set from the project's tag options (Settings). A tag since taken off the
 *  list stays on the store and is offered too, marked removed, so it can be changed. Saved at once. Read-only (a
 *  chip, or nothing) without the tag permission. The trigger is tinted by the tag (see `tagTone`); with no tag it
 *  is an outlined "Add tag" button. */
export function StoreTagPicker({ project, stop }: { project: Project; stop: Stop }) {
  const canTag = useCan("stores.tag");
  const save = useSetStoreTag(project.id);
  const tone = stop.tag ? tagTone(stop.tag) : null;
  if (!canTag) {
    return stop.tag ? (
      <span className={cn(tagChip(stop.tag), "inline-flex h-9 items-center gap-1.5 px-3 text-sm")} aria-label={`Tag: ${stop.tag}`}>
        <Tag size={14} className={tone?.icon} aria-hidden />
        {stop.tag}
      </span>
    ) : null;
  }
  const stale = stop.tag !== "" && !project.tag_options.includes(stop.tag);
  const change = (value: string) => {
    const tag = value === NONE ? "" : value;
    if (tag === stop.tag) return;
    save.mutate({ uid: stop.uid, tag }, { onError: (error) => toast.error(error instanceof Error ? error.message : "Could not save the tag") });
  };
  return (
    <Select value={stop.tag || NONE} onValueChange={change} disabled={save.isPending}>
      <SelectTrigger
        aria-label="Tag"
        title={stop.tag ? "Tag: change or remove" : "Add a tag"}
        className={cn(
          "h-9 min-w-32 max-w-60 gap-1.5 rounded-lg px-3 font-medium shadow-xs",
          tone ? tone.control : "border-dashed border-slate-400 bg-white text-slate-800 hover:border-brand hover:text-brand",
        )}
      >
        {save.isPending ? <Loader2 className="animate-spin text-slate-500" aria-hidden /> : <Tag className={tone?.icon ?? "text-slate-500"} aria-hidden />}
        <span className="min-w-0 flex-1 truncate text-left">
          <SelectValue>{stop.tag ? (stale ? `${stop.tag} (removed)` : stop.tag) : "Add tag"}</SelectValue>
        </span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>No tag</SelectItem>
        {project.tag_options.map((option) => (
          <SelectItem key={option} value={option}>
            <span className={cn("size-2 rounded-full", tagTone(option).dot)} aria-hidden />
            {option}
          </SelectItem>
        ))}
        {stale && (
          <SelectItem value={stop.tag}>
            <span className={cn("size-2 rounded-full", tagTone(stop.tag).dot)} aria-hidden />
            {stop.tag} (removed)
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

/** A done store (Completed or Offline) with fewer screen rows than committed counts in the Needs review tile. Someone
 *  who has checked it can ignore that; the ignore lasts while the committed total and the screen rows stay as they
 *  are now. Shown only while the saved store has the mismatch. */
export function MismatchNotice({ project, stop }: { project: Project; stop: Stop }) {
  const canEdit = useCan("projects.edit");
  const ignore = useIgnoreMismatch(project.id);
  if (!stop.screen_mismatch) return null;
  const committed = stop.committed_screens_total;
  const rows = stop.screens.length;
  const act = (on: boolean) =>
    ignore.mutate(
      { uid: stop.uid, ignore: on },
      { onError: (error) => toast.error(error instanceof Error ? error.message : "Could not save") },
    );
  const ignored = stop.mismatch_ignored;
  return (
    <div
      role="note"
      aria-label="Screen mismatch"
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-xl border px-4 py-2 text-sm shadow-sm",
        ignored ? "border-slate-200 bg-white text-slate-600" : "border-amber-200 bg-amber-50 text-amber-900",
      )}
    >
      {ignored && <CircleSlash size={14} className="text-slate-400" aria-hidden />}
      <span className="min-w-0 flex-1">
        {committed} committed, {rows} screen {rows === 1 ? "row" : "rows"}
        {ignored ? ": mismatch ignored. It is left out of Needs review while these numbers stay the same." : ": this store counts in Needs review."}
      </span>
      {canEdit && (
        <Button type="button" size="sm" variant="outline" className="h-9" disabled={ignore.isPending} onClick={() => act(!ignored)}>
          {ignore.isPending ? <Loader2 className="animate-spin" /> : ignored ? <Undo2 /> : null}
          {ignored ? "Undo" : "Ignore mismatch"}
        </Button>
      )}
    </div>
  );
}
