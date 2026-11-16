import { useState, type ReactNode } from "react";
import { Cpu, Loader2, User, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStoreLogs } from "@/features/device/api";
import type { DeviceLog } from "@/lib/api/types";
import { cn, SURFACE } from "@/lib/utils";

const ALL = "__all__";

/** The CMS's servicing log for one store: what was found at its devices and who dealt with it, newest first.
 *  Matched by the store's DD codes; the drop-down narrows to one of them. Read-only. */
export function StoreLogs({
  projectId,
  stopUid,
}: {
  projectId: string;
  stopUid: string;
}) {
  const [code, setCode] = useState(ALL);
  const logs = useStoreLogs(projectId, stopUid, code === ALL ? "" : code);
  const pages = logs.data?.pages ?? [];
  const first = pages[0];
  const items = pages.flatMap((page) => page.items);
  const codes = first?.codes ?? [];
  return (
    <section aria-label="Logs" className="space-y-3">
      <div className="flex items-center gap-2">
        <Select
          value={code}
          onValueChange={setCode}
          disabled={codes.length === 0}
        >
          <SelectTrigger
            size="sm"
            aria-label="DD code"
            className="min-w-44 font-mono text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>
              All DD codes{codes.length ? ` (${codes.length})` : ""}
            </SelectItem>
            {codes.map((value) => (
              <SelectItem key={value} value={value} className="font-mono">
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {first && (
          <span className="text-xs text-slate-500">
            {first.total === 1
              ? "1 entry"
              : `${first.total.toLocaleString()} entries`}
          </span>
        )}
        {logs.isFetching && (
          <Loader2 className="size-4 animate-spin text-slate-400" />
        )}
      </div>
      {logs.isError && (
        <p className="text-sm text-rose-700">
          Could not load the logs: {logs.error.message}
        </p>
      )}
      {first && codes.length === 0 && (
        <p className="text-sm text-slate-500">
          This store has no DD code yet, and logs are found by DD code.
        </p>
      )}
      {first && codes.length > 0 && items.length === 0 && (
        <p className="text-sm text-slate-500">
          No log entries for {code === ALL ? "these DD codes" : code}.
        </p>
      )}
      {/* A timeline: a rail down the left with a dot per entry, the newest (first) one filled. */}
      <ol
        className="relative space-y-3 border-l-2 border-brand/30 pl-5"
        aria-label="Log entries"
      >
        {items.map((log, index) => (
          <LogEntry
            key={log.id || `${log.dd_code}-${log.date}-${index}`}
            log={log}
            newest={index === 0}
          />
        ))}
      </ol>
      {logs.hasNextPage && (
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          disabled={logs.isFetchingNextPage}
          onClick={() => void logs.fetchNextPage()}
        >
          {logs.isFetchingNextPage && <Loader2 className="animate-spin" />} Show
          more
        </Button>
      )}
    </section>
  );
}

/** Who did what, as a small labelled value with an icon chip (the log page's layout). */
function Person({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[11px] text-slate-400">{label}</p>
        <p className="truncate text-sm font-medium text-slate-900">
          {value || <span className="font-normal text-slate-300">—</span>}
        </p>
      </div>
    </div>
  );
}

/** One entry as a card on the timeline: the day, the DD code and what was wrong; the device's CMS name; the stick,
 *  the technician and the Dolphin manager; then the comment. PA and FA are the store's, so they are not repeated. */
function LogEntry({ log, newest }: { log: DeviceLog; newest: boolean }) {
  const stick = [log.stick_number, log.stick_model].filter(Boolean).join(" · ");
  return (
    <li className={cn(SURFACE, "relative space-y-3 p-4")}>
      <span
        className={cn(
          "absolute -left-[27px] top-5 size-3 rounded-full ring-4 ring-white",
          newest ? "bg-brand" : "bg-slate-300",
        )}
        aria-hidden
      />
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <time
          className="text-base font-semibold text-slate-900"
          dateTime={log.date}
        >
          {log.date || "No date"}
        </time>
        <span className="font-mono text-xs font-semibold text-brand">
          {log.dd_code}
        </span>
        {log.category && (
          <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-xs font-medium text-slate-700">
            {log.category}
          </span>
        )}
      </div>
      {log.venue_name && (
        <p className="break-all font-mono text-xs text-slate-500">
          {log.venue_name}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Person icon={<Cpu size={15} />} label="Stick" value={stick} />
        <Person
          icon={<Wrench size={15} />}
          label="Installer"
          value={log.installer}
        />
        <Person
          icon={<User size={15} />}
          label="Dolphin Manager"
          value={log.dolphin_manager}
        />
      </div>
      {log.detailed_comments && (
        <p className="whitespace-pre-wrap break-words border-t border-slate-100 pt-3 text-sm leading-relaxed text-slate-800">
          {log.detailed_comments}
        </p>
      )}
    </li>
  );
}
