import { useCan, useMe } from "@/lib/auth/me";
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightLeft, Cable, CalendarX, Check, ChevronRight, Eye, EyeOff, Loader2, Lock, MapPinOff, Pencil, Pin, Plus, Send, Signal, Store, Trash2, Wifi, X } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { shownLocation, StoreLocationMap } from "@/components/map/StoreLocationMap";
import { WhenVisible } from "@/components/WhenVisible";
import { NameField } from "@/components/NameField";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCategories } from "@/features/lists/api";
import { STOP_STATE_LABEL, STOP_STATES, todayIso, type StopState } from "@/features/planner/planModel";
import { useStoreFields } from "@/features/places/api";
import { useStore, useUpdateProgress, useUpdateScreens, useUpdateStoreDetails } from "@/features/stores/api";
import { newRow, ScreenFields, toInputs, toRows, type ScreenRow } from "@/features/stores/ScreensEditor";
import { INSTALLED_STATUSES } from "@/features/stores/details";
import { ImagePreviews, ScreenPictures } from "@/features/stores/Pictures";
import { urlTokens } from "@/lib/validation/storeFields";
import { computedMounts, computedMountsUsed, computedMountsUsedByPiece } from "@/features/stores/StoreSummary";
import { useCreateStoreComment, useCreateVisit, useStoreComments, useVenue, useVisits } from "@/features/visits/api";
import {
  canEditStoreDetails,
  LOCKED_GROUPS,
  lockedPatch,
  lockedValues,
  formErrors,
  NETWORK_TYPES,
  REPLACED_WITH,
  screenOutcomes,
  screenOutcomesOn,
  toInput,
  venueNameOf,
  type LockedKey,
  type LockedValues,
  type VisitForm,
} from "@/features/visits/visitForm";
import { keys } from "@/lib/api/keys";
import { projectsApi } from "@/lib/api/resources";
import { STOP_STATUSES, type Me, type NetworkType, type Project, type ScreenStatus, type Stop, type StoreComment, type StoreFieldSpec, type Visit } from "@/lib/api/types";
import { bucketOf, STATUS_META } from "@/lib/status";
import { cn, SURFACE } from "@/lib/utils";
import { VISIT_TONE, type VisitToneName } from "@/features/visits/visitTone";

const MANAGER_KEY = "dolphin-tracker.last-manager";
const NETWORK_ICONS: Record<NetworkType, typeof Wifi> = { WiFi: Wifi, Ethernet: Cable, LTE: Signal };

interface Props {
  projectId: string | null;
  stopUid: string | null;
  /** The plan the visit is logged from ("" = the store's active plan, if any). */
  planId?: string;
  installer?: string;
  visitDate?: string | null;
  /** Opened from a route plan: its state chip and plan actions by the store's name. Without it (the Log Visit page,
   *  the store window) the same store window shows, without them. */
  plan?: PlanVisit;
  onClose: () => void;
}

export interface PlanVisit {
  /** Where the stop stands in the plan now (worked out from its screens' log entries, or marked on the plan). */
  state: StopState;
  /** The stop's plan actions, as its day card offers them (the planner passes its own handlers). Each shows only
   *  when its handler is given and the signed-in person has the permission the day card asks for. */
  actions?: PlanStopActions;
}

export interface PlanStopActions {
  /** Every screen has a log entry in the plan: Done by its visits, so it is not marked by hand. */
  byVisits: boolean;
  /** Some screen was logged in the plan: it stays on its day and in the plan (Move can still change the day). */
  hasVisit: boolean;
  /** Put on its day by hand: recalculations leave it there. */
  pinned: boolean;
  /** Taken off its day, still held by the plan. */
  removed: boolean;
  /** Another day or installer (Put back, for a removed stop). */
  onMove?: () => void;
  onMark?: (state: StopState) => void;
  onUnpin?: () => void;
  /** Off its day, kept with the plan as removed. */
  onSetAside?: () => void;
  /** Out of the plan for good (the planner asks first). */
  onRemove?: () => void;
}

/** The Dolphin manager a new log entry starts with: the signed-in person's name. Never a role or an email (the
 *  account menu shows the email only when there is no name), and not the local stand-in when sign-in is off. */
export function signedInName(me: Pick<Me, "id" | "name"> | undefined): string {
  const name = me && me.id !== "local" ? me.name.trim() : "";
  return name.includes("@") ? "" : name;
}

/** The signed-in person's name, else the one remembered from the last entry logged here, else empty. */
function useManagerDefault(): string {
  const me = useMe().data;
  return signedInName(me) || window.localStorage.getItem(MANAGER_KEY) || "";
}

function Field({ label, required, error, children, htmlFor }: { label: string; required?: boolean; error?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-sm">
        {label} {required && <span className="text-rose-600">*</span>}
      </Label>
      {children}
      {error && <p className="text-xs text-rose-700">{error}</p>}
    </div>
  );
}

function YesNo({ label, value, onChange, error }: { label: string; value: boolean | null; onChange: (v: boolean) => void; error?: string }) {
  return (
    <Field label={label} required error={error}>
      <div role="radiogroup" aria-label={label} className="grid grid-cols-2 gap-2">
        {[true, false].map((option) => (
          <button
            key={String(option)}
            type="button"
            role="radio"
            aria-checked={value === option}
            onClick={() => onChange(option)}
            className={cn("h-11 rounded-lg border-2 text-sm font-medium", value === option ? "border-brand bg-brand/10 text-brand" : "border-slate-200 text-slate-600")}
          >
            {option ? "Yes" : "No"}
          </button>
        ))}
      </div>
    </Field>
  );
}

/** A section's icon in a small chip of its hue (decoration: the title beside it names the section). */
function VisitChip({ name }: { name: VisitToneName }) {
  const { icon: Icon, chip } = VISIT_TONE[name];
  return (
    <span aria-hidden className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-md", chip)}>
      <Icon size={13} strokeWidth={2.25} />
    </span>
  );
}

const TONE_TITLE = "font-mono text-[11px] font-medium uppercase tracking-wider";

/** A section's header strip, as the store window draws its sections: a light tint of the section's hue, its icon
 *  chip and a mono title, with whatever belongs on the right (a summary, Edit, a link). */
function ToneStrip({ name, title, heading: Heading = "h4", className, children }: { name: VisitToneName; title?: ReactNode; heading?: "h3" | "h4" | "h5"; className?: string; children?: ReactNode }) {
  const tone = VISIT_TONE[name];
  return (
    <div className={cn("flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1.5", tone.strip, tone.line, className)}>
      <VisitChip name={name} />
      <Heading className={cn(TONE_TITLE, "min-w-0", tone.title)}>{title ?? name}</Heading>
      {children}
    </div>
  );
}

/** The store as a visit logs it: what to bring, who is logging, its screens (each logged on its own: network,
 *  software, issue, comment, Done or Incomplete), and on the right who the store is and every log entry. The same
 *  window from a route plan (`plan`: its chips and actions too) and from anywhere else. */
export function VisitPanel({ projectId, stopUid, planId = "", installer = "", visitDate, plan, onClose }: Props) {
  const open = Boolean(projectId && stopUid);
  const store = useStore(projectId ?? "", open ? stopUid : null);
  const project = useQuery({
    queryKey: keys.project(projectId ?? ""),
    queryFn: () => projectsApi.get(projectId ?? ""),
    enabled: Boolean(projectId),
  });
  const stop = store.data;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      {/* Glass over the dimmed page, as the store window: the header a near-white glass bar, every section a solid
          card on the pane (index.css, .glass-pane / .glass-bar). */}
      <DialogContent className="glass-pane flex max-h-[94vh] w-[90vw] max-w-[90vw] flex-col gap-0 overflow-hidden rounded-[22px] p-0 sm:max-w-[90vw]">
        {/* The store draws its own header once loaded: its name, chips and (from a plan) the plan actions. */}
        {!(stop && project.data) && (
          <DialogHeader className="glass-bar border-b border-(--glass-bar-line) px-6 pt-5 pb-3 pr-12">
            <DialogTitle className="text-xl">Store</DialogTitle>
            <DialogDescription>Loading the store…</DialogDescription>
          </DialogHeader>
        )}
        {stop && project.data ? (
          <StoreVisit key={stop.uid} stop={stop} project={project.data} planId={planId} installer={installer} visitDate={visitDate ?? todayIso()} plan={plan} />
        ) : (
          <div className={cn(SURFACE, "m-4 p-10 text-center font-mono text-sm text-slate-600")}>{store.isError ? `Could not load the store: ${store.error.message}` : "Loading…"}</div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Who the store is, read only. With a DD code (the store's first, or the one typed in the log entry) the values
 *  come from the CMS data (CMS) for that code: name, venue name, address, PA, DMA and status. Without one, or
 *  when the code is not in the data, the project's own. FA is the project's (the CMS has none). */
function StoreIdentity({ stop, project, code }: { stop: Stop; project: Project; code?: string }) {
  const lookup = code ?? stop.screens.find((screen) => screen.venue_id)?.venue_id ?? "";
  const venue = useVenue(lookup);
  const cms = venue.data ?? null;
  const device = stop.device;
  const sheetAddress = device?.address || [stop.addr, stop.city, [stop.state, stop.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const cmsAddress = cms ? cms.geocoded || [cms.addr, cms.city, [cms.state, cms.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ") : "";
  const rows: [string, string][] = [
    ["Name", cms?.store_name || device?.store_name || stop.store_name],
    ...(cms?.screens[0]?.cms_name ? ([["CMS name", cms.screens[0].cms_name]] as [string, string][]) : []),
    ["Address", cmsAddress || sheetAddress],
    ["PA", cms?.pa || stop.pa || project.pa],
    ["FA", project.field_agent],
    // The store's, not a screen's: the CMS's for the code, else the store's own, else what a screen was given.
    ["Venue type", cms?.venue_type || stop.venue_type || stop.screens.find((screen) => screen.venue_type)?.venue_type || ""],
    ...(cms ? ([["DMA", cms.dma ?? ""], ["CMS status", STATUS_META[cms.status]?.label ?? cms.status]] as [string, string][]) : []),
  ];
  return (
    <section aria-label="Store" className={cn(SURFACE, "overflow-hidden text-sm")}>
      <ToneStrip name="Store" heading="h3">
        <span className={cn("min-w-0 text-xs", VISIT_TONE.Store.summary)}>
          {venue.isFetching ? "looking up the DD code…" : cms ? `from the CMS (${lookup})` : lookup ? `${lookup} is not in the CMS data: the project's values` : "the project's values (no DD code yet)"}
        </span>
      </ToneStrip>
      <dl className="space-y-1.5 p-4">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[80px_minmax(0,1fr)] gap-2">
            <dt className="text-xs text-slate-500">{label}</dt>
            <dd className="break-words text-sm font-medium text-slate-900">{value || <span className="font-normal text-slate-300">—</span>}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const MOUNT_PIECES = [["wall_24", 'Wall 24"'], ["wall", "Wall"], ["ceiling", "Ceiling"]] as const;
const pieces = (counts: Record<(typeof MOUNT_PIECES)[number][0], number>): [string, number][] =>
  MOUNT_PIECES.map(([key, label]) => [label, counts[key]] as [string, number]).filter(([, count]) => count > 0);
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** What to bring for the screens still to be installed (Upcoming): sticks, screens by size and brand, mounts by
 *  kind. Nothing for a store with no Upcoming screen (an Offline visit brings what the log says). */
export function inventoryNeeded(stop: Stop): { sticks: number; screens: [string, number][]; storeTvs: number; mounts: [string, number][] } | null {
  const upcoming = stop.screens.filter((screen) => bucketOf(screen.status) === "Upcoming");
  if (!upcoming.length) return null;
  const screens = new Map<string, number>();
  for (const screen of upcoming.filter((item) => item.is_dolphin_screen)) {
    const label = [screen.screen_size || '24"', screen.screen_type].filter(Boolean).join(" ");
    screens.set(label, (screens.get(label) ?? 0) + 1);
  }
  return { sticks: upcoming.length, screens: [...screens], storeTvs: upcoming.filter((item) => !item.is_dolphin_screen).length, mounts: pieces(computedMounts(stop.screens)) };
}

/** What the store's installed screens (Completed, Offline, Serviced - Needs More Work) took: our screens, the
 *  store's own TVs, and the mounts on the wall per piece (StoreSummary's counts, the store window's). */
export function inventoryUsed(stop: Stop): { screens: number; storeTvs: number; mounts: [string, number][]; mountsTotal: number } {
  const installed = stop.screens.filter((screen) => INSTALLED_STATUSES.has(screen.status));
  return {
    screens: installed.filter((screen) => screen.is_dolphin_screen).length,
    storeTvs: installed.filter((screen) => !screen.is_dolphin_screen).length,
    mounts: pieces(computedMountsUsedByPiece(stop.screens)),
    mountsTotal: computedMountsUsed(stop.screens),
  };
}

/** The one line the folded strip shows: "Needed: 1 stick · 1 screen · 0 mounts — Used: 0 screens · 0 mounts". */
export function inventoryLine(stop: Stop): string {
  const need = inventoryNeeded(stop);
  const used = inventoryUsed(stop);
  const total = (items: [string, number][]) => items.reduce((sum, [, count]) => sum + count, 0);
  const needed = need
    ? [plural(need.sticks, "stick"), plural(total(need.screens), "screen"), need.storeTvs && plural(need.storeTvs, "store TV"), plural(total(need.mounts), "mount")]
    : ["nothing to install"];
  const took = [plural(used.screens, "screen"), used.storeTvs && plural(used.storeTvs, "store TV"), plural(used.mountsTotal, "mount")];
  return `Needed: ${needed.filter(Boolean).join(" · ")} — Used: ${took.filter(Boolean).join(" · ")}`;
}

function InventoryBox({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-24 rounded-md border border-slate-200 bg-white px-2.5 py-1.5">
      <div className="text-[11px] text-slate-600">{label}</div>
      <div className="text-sm font-semibold tabular-nums text-slate-900">{children}</div>
    </div>
  );
}

function CountList({ items, none }: { items: [string, number][]; none: string }) {
  if (!items.length) return <span className="font-normal text-slate-400">{none}</span>;
  return (
    <ul className="flex flex-wrap gap-x-2.5">
      {items.map(([label, count]) => (
        <li key={label}>
          {count} × {label}
        </li>
      ))}
    </ul>
  );
}

/** What to bring and what the store already took, folded to one line. Open by itself when there is something to
 *  bring; nothing is remembered. */
function InventoryStrip({ stop }: { stop: Stop }) {
  const need = inventoryNeeded(stop);
  const used = inventoryUsed(stop);
  const [open, setOpen] = useState(need !== null);
  return (
    <section aria-label="Inventory" className={cn(SURFACE, "shrink-0 overflow-hidden")}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="inventory-groups"
        onClick={() => setOpen(!open)}
        className={cn(
          "flex min-h-10 w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none",
          VISIT_TONE.Inventory.strip,
          VISIT_TONE.Inventory.hover,
        )}
      >
        <ChevronRight className={cn("size-3.5 shrink-0 text-slate-500 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
        <VisitChip name="Inventory" />
        <span className={cn(TONE_TITLE, VISIT_TONE.Inventory.title)}>Inventory</span>
        {!open && <span className={cn("min-w-0 truncate", VISIT_TONE.Inventory.summary)}>{inventoryLine(stop)}</span>}
      </button>
      {open && (
        <div id="inventory-groups" className={cn("flex flex-wrap gap-x-8 gap-y-2 border-t px-4 py-2.5", VISIT_TONE.Inventory.line)}>
          <div role="group" aria-label="Needed" className="space-y-1">
            <h4 className="text-xs font-medium text-slate-600">Needed <span className="font-normal text-slate-500">· for screens not installed yet</span></h4>
            {need ? (
              <div className="flex flex-wrap gap-1.5">
                <InventoryBox label="Sticks">{need.sticks}</InventoryBox>
                <InventoryBox label="Screens">
                  <CountList items={need.screens} none="None to bring" />
                </InventoryBox>
                {need.storeTvs > 0 && <InventoryBox label="Store TVs (stick only)">{need.storeTvs}</InventoryBox>}
                <InventoryBox label="Mounts">
                  <CountList items={need.mounts} none="None" />
                </InventoryBox>
              </div>
            ) : (
              <p className="text-xs text-slate-500">Nothing: every screen is installed.</p>
            )}
          </div>
          <div role="group" aria-label="Used" className="space-y-1">
            <h4 className="text-xs font-medium text-slate-600">Used <span className="font-normal text-slate-500">· by the installed screens</span></h4>
            <div className="flex flex-wrap gap-1.5">
              <InventoryBox label="Screens">{used.screens}</InventoryBox>
              {used.storeTvs > 0 && <InventoryBox label="Store TVs">{used.storeTvs}</InventoryBox>}
              <InventoryBox label={`Mounts · ${used.mountsTotal}`}>
                <CountList items={used.mounts} none="None" />
              </InventoryBox>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

const OUTCOME_LABEL = { done: "Done", incomplete: "Incomplete" } as const;
const OUTCOME_TONE = { done: "border-emerald-300 bg-emerald-50 text-emerald-800", incomplete: "border-amber-300 bg-amber-50 text-amber-800" } as const;

interface LogDraft {
  network_type: NetworkType | "";
  /** Ticked: this screen is not on the store's WiFi, and its own is typed. */
  otherWifi: boolean;
  wifi_ssid: string;
  wifi_password: string;
  latest_apk: boolean | null;
  kiosk_mode: boolean | null;
  dagent_installed: boolean | null;
  category: string;
  subcategory: string;
  replaced_with: string;
  comments: string;
  outcome: "" | "done" | "incomplete";
}

const EMPTY_LOG: LogDraft = {
  network_type: "", otherWifi: false, wifi_ssid: "", wifi_password: "", latest_apk: null, kiosk_mode: null, dagent_installed: null,
  category: "", subcategory: "", replaced_with: "", comments: "", outcome: "",
};

const sameScreen = (a: ScreenRow, b: ScreenRow) => JSON.stringify(toInputs([{ ...a, key: "" }])) === JSON.stringify(toInputs([{ ...b, key: "" }]));

/** Who is logging and when: the same for every screen logged in this sitting. */
interface Who {
  visit_date: string;
  installer: string;
  dolphin_manager: string;
}

/** One screen's unsaved input while the dialog is open (kept when another screen is picked): its details, once
 *  changed, and this visit's log. */
interface ScreenDraft {
  row?: ScreenRow;
  log: LogDraft;
  touched: boolean;
}

const NO_DRAFT: ScreenDraft = { log: EMPTY_LOG, touched: false };

const hasInput = (draft: ScreenDraft | undefined, base: ScreenRow) =>
  Boolean(draft) && ((draft!.row !== undefined && !sameScreen(base, draft!.row)) || JSON.stringify(draft!.log) !== JSON.stringify(EMPTY_LOG));

const screenCodes = (row: Pick<ScreenRow, "stick_number" | "venue_id">) => [row.stick_number && `Stick ${row.stick_number}`, row.venue_id].filter(Boolean).join(" · ");

/** The store as a visit opens it. On top: its name with its chips (and, from a plan, the stop's and its plan
 *  actions), then what to bring and who is logging. Left: its screens (pick one to log it), with Add screen and the
 *  store's comment. Middle: the picked screen's log (what the screen is, its pictures, network, software, issue,
 *  comment, Done or Incomplete), and the store on a small map. Right, as wide as the middle: Details (who the store
 *  is, its WiFi and contacts behind Edit, the sheet's notes) or Logs (every entry). Without a plan a screen counts as
 *  logged when it has an entry dated the visit's day. */
function StoreVisit({ stop, project, planId, installer, visitDate, plan }: { stop: Stop; project: Project; planId: string; installer: string; visitDate: string; plan?: PlanVisit }) {
  const history = useVisits(project.id, stop.uid);
  const visits = history.data?.items ?? [];
  const storeComments = useStoreComments(project.id, stop.uid);
  const update = useUpdateScreens(project.id);
  const canLog = useCan("visits.log"); // without it the store is shown, nothing can be changed
  // Someone who only logs visits changes the screens, WiFi and comment only while the store is on a route.
  const canEditDetails = canEditStoreDetails(useMe().data?.permissions ?? [], stop);
  const updatedBy = (name: string) => name.trim() || (plan ? "Route planner" : "Log visit");
  const managerDefault = useManagerDefault();
  const [who, setWho] = useState<Who>(() => ({ visit_date: visitDate, installer: installer || stop.installer_name || "", dolphin_manager: managerDefault }));
  const [picked, setPicked] = useState<string | null>(null); // the key of the screen picked in the bar
  const [drafts, setDrafts] = useState<Record<string, ScreenDraft>>({});
  const [adding, setAdding] = useState<ScreenRow | null>(null); // a screen not saved yet
  const [addedId, setAddedId] = useState<string | null>(null); // …or saved, while its log is still open
  const [removing, setRemoving] = useState<ScreenRow | null>(null);
  const [side, setSide] = useState<"details" | "logs">("details");
  const saved = toRows(stop);
  const rows = [...saved.filter((row) => row.id !== addedId), ...(adding ? [adding] : [])];
  const outcomes = plan ? screenOutcomes(visits, planId) : screenOutcomesOn(visits, who.visit_date);
  const logged = saved.filter((row) => outcomes.has(row.id ?? "")).length;
  const entryCount = visits.length + (storeComments.data?.items.length ?? 0);
  const moreEntries = Boolean(history.data?.next_cursor || storeComments.data?.next_cursor);
  // Until one is picked: the first screen not logged in this plan yet.
  const selectedKey = rows.some((row) => row.key === picked) ? picked! : (rows.find((row) => !outcomes.has(row.id ?? "")) ?? rows[0])?.key;
  const selectedIndex = rows.findIndex((row) => row.key === selectedKey);
  const selected = rows[selectedIndex];

  const dropDraft = (key: string) =>
    setDrafts(({ [key]: _gone, ...rest }) => rest);
  const changeDraft = (key: string, change: (draft: ScreenDraft) => ScreenDraft) => {
    setPicked(key); // typing into a screen keeps it picked, even once the history says another is first
    setDrafts((current) => ({ ...current, [key]: change(current[key] ?? NO_DRAFT) }));
  };
  const startAdding = () => {
    const row = newRow();
    setAdding(row);
    setAddedId(null);
    setPicked(row.key);
  };
  const stopAdding = () => {
    if (adding) dropDraft(adding.key);
    setAdding(null);
    setAddedId(null);
    setPicked(null);
  };
  const afterSave = (key: string, screenId: string, withLog: boolean) => {
    if (!withLog) {
      // The details are on the store now; what is typed for the log stays.
      setDrafts((current) => (current[key] ? { ...current, [key]: { ...current[key]!, row: undefined } } : current));
      return;
    }
    dropDraft(key);
    if (adding?.key === key) {
      setAdding(null);
      setAddedId(null);
    }
    const next = rows.find((row) => row.key !== key && row.id !== screenId && row.id && !outcomes.has(row.id));
    setPicked(next?.key ?? screenId);
  };
  const remove = async (row: ScreenRow) => {
    setRemoving(null);
    try {
      await update.mutateAsync({ uid: stop.uid, screens: toInputs(saved.filter((item) => item.id !== row.id)), updatedBy: updatedBy(who.installer) });
      dropDraft(row.key);
      if (picked === row.key) setPicked(null);
      toast.success("Screen removed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove the screen");
    }
  };
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const to = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: rows.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const row = rows[(to + rows.length) % rows.length]!;
    setPicked(row.key);
    document.getElementById(`screen-tab-${row.key}`)?.focus();
  };

  return (
    <>
      <StoreHeader stop={stop} project={project} plan={plan} logged={logged} screens={saved.length} visitDate={who.visit_date} />
      {/* The pane under the header: every block a solid card on the glass, the three columns scrolling on their own. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pt-3 pb-4">
        {/* Inventory and who/when side by side on a wide window, so the two take one row of height, not two. */}
        <div className="flex shrink-0 flex-col gap-3 xl:flex-row xl:items-stretch">
        <div className="min-w-0 xl:flex-1 [&>section]:h-full">
          <InventoryStrip stop={stop} />
        </div>
        <section aria-label="This visit" hidden={!canLog} title="Used for every screen logged now" className={cn(SURFACE, "shrink-0 px-4 py-3 xl:w-[46rem]")}>
          <div className="grid items-end gap-3 sm:grid-cols-3">
            <Field label="Date" required htmlFor="visit-date">
              <Input id="visit-date" type="date" value={who.visit_date} onChange={(e) => setWho({ ...who, visit_date: e.target.value })} />
            </Field>
            <Field label="Technician" required>
              <NameField kind="installers" aria-label="Technician" placeholder="Select or type technician name" value={who.installer} onChange={(value) => setWho({ ...who, installer: value })} />
            </Field>
            <Field label="Dolphin Manager" required>
              <NameField kind="managers" aria-label="Dolphin Manager" placeholder="Select or type manager name" value={who.dolphin_manager} onChange={(value) => setWho({ ...who, dolphin_manager: value })} />
            </Field>
          </div>
          <p className="mt-1.5 text-[11px] text-slate-600">Used for every screen logged now.</p>
        </section>
        </div>
        {/* The form and the store's side share what the bar leaves, half each. Whatever scrolls pads by a hair (the grid
            takes it back with a negative margin) so the cards' rings and shadows are not clipped by the scroll. */}
        <div className="-m-1 grid min-h-0 flex-1 gap-3 overflow-y-auto p-1 lg:gap-1 lg:p-0 lg:grid-cols-[210px_minmax(0,1fr)_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[240px_minmax(0,1fr)_minmax(0,1fr)] 2xl:grid-cols-[260px_minmax(0,1fr)_minmax(0,1fr)]">
          <nav aria-label="Screens" className="flex min-w-0 flex-col gap-3 lg:overflow-y-auto lg:p-1">
            <div className={cn(SURFACE, "overflow-hidden")}>
              <ToneStrip name="Screens" heading="h3" title={`Screens · ${saved.length}`}>
                <Button size="sm" variant="outline" className="ml-auto h-7" hidden={!canEditDetails} disabled={adding !== null} onClick={startAdding}>
                  <Plus /> Add screen
                </Button>
              </ToneStrip>
              <div role="tablist" aria-orientation="vertical" aria-label="Screens of this store" className="space-y-1 p-2">
                {rows.map((row, index) => {
                  const isSelected = row.key === selectedKey;
                  const outcome = outcomes.get(row.id ?? "");
                  return (
                    <button
                      key={row.key}
                      id={`screen-tab-${row.key}`}
                      type="button"
                      role="tab"
                      aria-selected={isSelected}
                      aria-controls="screen-panel"
                      tabIndex={isSelected ? 0 : -1}
                      onClick={() => setPicked(row.key)}
                      onKeyDown={(event) => moveFocus(event, index)}
                      className={cn(
                        "w-full space-y-1 rounded-lg border px-3 py-2 text-left transition-colors motion-reduce:transition-none",
                        // The picked screen in the brand colour, plainly: a brand outline, a brand tint and a brand title.
                        isSelected ? "border-brand bg-brand/[0.07] shadow-sm ring-1 ring-brand" : "border-transparent hover:border-slate-200 hover:bg-slate-50",
                      )}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className={cn("text-sm font-semibold", isSelected ? "text-brand-strong" : "text-slate-900")}>Screen {index + 1}</span>
                        <span className={cn("rounded border px-1.5 py-0.5 text-[11px] font-medium", STATUS_META[row.status].chip)}>{STATUS_META[row.status].label}</span>
                      </span>
                      <span className="block truncate font-mono text-xs text-slate-600">{screenCodes(row) || "No stick or DD code yet"}</span>
                      <span className="flex items-center gap-2 text-xs">
                        {!row.id ? (
                          <span className="text-brand">New, not saved</span>
                        ) : outcome ? (
                          <span className={cn("rounded border px-1.5 py-px text-[11px] font-medium", OUTCOME_TONE[outcome])}>{OUTCOME_LABEL[outcome]}</span>
                        ) : (
                          <span className="text-slate-500">Not logged</span>
                        )}
                        {row.id && hasInput(drafts[row.key], row) && <span className="text-brand">· Unsaved input</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="lg:mt-auto">
              <StoreComment stop={stop} projectId={project.id} planId={planId} who={who} readOnly={!canEditDetails} />
            </div>
          </nav>

          <div role="tabpanel" id="screen-panel" aria-labelledby={selected ? `screen-tab-${selected.key}` : undefined} className="@container min-w-0 space-y-3 lg:overflow-y-auto lg:p-1">
            {selected ? (
              <ScreenLog
                key={selected.key}
                stop={stop}
                project={project}
                row={selected}
                number={selectedIndex + 1}
                planId={planId}
                who={who}
                readOnly={!canLog}
                canEditDetails={canEditDetails}
                updatedBy={updatedBy(who.installer)}
                value={drafts[selected.key] ?? NO_DRAFT}
                dirty={hasInput(drafts[selected.key], selected)}
                onChange={(change) => changeDraft(selected.key, change)}
                onCreated={setAddedId}
                onSaved={(screenId, withLog) => afterSave(selected.key, screenId, withLog)}
                onDiscard={() => (selected.id && selected.id !== addedId ? dropDraft(selected.key) : stopAdding())}
                onDelete={canEditDetails && selected.id && selected.id !== addedId && saved.length > 1 && !update.isPending ? () => setRemoving(selected) : undefined}
              />
            ) : (
              <p className={cn(SURFACE, "p-10 text-center text-sm text-slate-600")}>This store has no screens yet.</p>
            )}
          </div>

          <aside className="@container flex min-w-0 flex-col gap-3 lg:gap-2 lg:overflow-hidden" aria-label="Store details">
            {/* The column shows the store's details or every log entry; the form beside it stays as it is. The switch is
                the store window's (its Other details / Logs pill). */}
            <div className="shrink-0 lg:px-1 lg:pt-1">
              <div role="tablist" aria-label="Store side" className="inline-flex rounded-xl bg-white/60 p-1 text-sm font-medium shadow-sm ring-1 ring-slate-900/5">
                {(["details", "logs"] as const).map((view) => (
                  <button
                    key={view}
                    id={`side-tab-${view}`}
                    type="button"
                    role="tab"
                    aria-selected={side === view}
                    aria-controls={`side-panel-${view}`}
                    onClick={() => setSide(view)}
                    className={cn("flex h-8 items-center gap-1.5 rounded-lg px-4 transition-colors motion-reduce:transition-none", side === view ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-900/5" : "text-slate-600 hover:text-slate-900")}
                  >
                    {view === "details" ? "Details" : "Logs"}
                    {view === "logs" && (
                      <span className="rounded-full bg-slate-200/80 px-1.5 text-[11px] font-semibold tabular-nums text-slate-700">
                        {history.isPending ? "…" : `${entryCount}${moreEntries ? "+" : ""}`}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
            <div className="min-h-0 flex-1 lg:overflow-y-auto lg:p-1">
              {/* Hidden, not unmounted: a WiFi edit or a picked filter keeps its place across the switch. */}
              <div id="side-panel-details" role="tabpanel" aria-labelledby="side-tab-details" hidden={side !== "details"} className="space-y-3">
                <StoreIdentity stop={stop} project={project} />
                <LockedGroup stop={stop} projectId={project.id} title="Store WiFi" fields={LOCKED_GROUPS.wifi} canEdit={canEditDetails} stacked />
                <LockedGroup stop={stop} projectId={project.id} title="Owner" fields={LOCKED_GROUPS.owner} canEdit={canEditDetails} stacked />
                <LockedGroup stop={stop} projectId={project.id} title="Store Contact" fields={LOCKED_GROUPS.storeContact} canEdit={canEditDetails} stacked />
                <StoreSideNotes stop={stop} project={project} />
                {/* The store's place: a store-level detail, so it sits with the store's details, last. */}
                <StoreMap stop={stop} />
              </div>
              <div id="side-panel-logs" role="tabpanel" aria-labelledby="side-tab-logs" hidden={side !== "logs"} className={cn(SURFACE, "p-4")}>
                <LogEntries projectId={project.id} stop={stop} />
              </div>
            </div>
          </aside>
        </div>
      </div>
      <ConfirmDialog open={removing !== null} title="Delete this screen?" confirmLabel="Delete screen" onConfirm={() => removing && void remove(removing)} onCancel={() => setRemoving(null)}>
        {removing ? `Screen ${removing.stick_number || removing.venue_id || "without an id"} is removed from the store now. Its log entries stay in the history.` : ""}
      </ConfirmDialog>
    </>
  );
}

const STATE_TONE: Record<StopState, string> = { ...OUTCOME_TONE, route: "border-sky-300 bg-sky-50 text-sky-800" };
const CHIP = "inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs";

/** The store's name with where it stands (from a plan: the stop's state there; the store's status; how many
 *  screens are logged), and on the right, from a plan, the stop's plan actions the day card offers, for whoever may
 *  use them. */
function StoreHeader({ stop, project, plan, logged, screens, visitDate }: { stop: Stop; project: Project; plan?: PlanVisit; logged: number; screens: number; visitDate: string }) {
  const canArrange = useCan("routes.arrange");
  const canManage = useCan("routes.manage");
  const actions = plan?.actions;
  const state = plan?.state ?? "route";
  const tone = STATE_TONE[state];
  const canMark = Boolean(actions?.onMark) && canArrange && !actions!.byVisits && !actions!.removed;
  const canMove = Boolean(actions?.onMove) && (actions!.removed ? canManage : canArrange && state !== "done");
  const canSetAside = Boolean(actions?.onSetAside) && canArrange && !actions!.removed && state !== "done";
  const canRemove = Boolean(actions?.onRemove) && canManage && (actions!.removed || state !== "done");
  const canUnpin = Boolean(actions?.onUnpin) && canArrange && actions!.pinned && state !== "done";
  return (
    <DialogHeader className="glass-bar flex-row flex-wrap items-center gap-x-4 gap-y-2 border-b border-(--glass-bar-line) px-6 py-3.5 pr-14 text-left">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <DialogTitle className="mr-1 text-xl">{stop.device?.store_name || stop.store_name}</DialogTitle>
          {!plan ? null : canMark ? (
            <Select value={state} onValueChange={(next) => next !== state && actions!.onMark!(next as StopState)}>
              <SelectTrigger size="sm" aria-label="Stop in the plan" className={cn("h-7 text-xs font-medium", tone)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STOP_STATES.map((option) => (
                  <SelectItem key={option} value={option}>
                    {STOP_STATE_LABEL[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className={cn(CHIP, "font-medium", tone)} aria-label="Stop in the plan">
              {state === "done" && <Check className="size-3" />} {actions?.removed ? "Removed from its day" : STOP_STATE_LABEL[state]}
            </span>
          )}
          <span className={cn(CHIP, STATUS_META[stop.status]?.chip)} aria-label="Store status">
            {STATUS_META[stop.status]?.label ?? stop.status}
          </span>
          {actions?.pinned && state !== "done" && (
            <span className={cn(CHIP, "border-slate-300 bg-slate-50 pr-1 text-slate-700")} title="Put on this day by hand: recalculations leave it here">
              <Pin className="size-3" /> Kept on this day
              {canUnpin && (
                <button type="button" aria-label="Let it be recalculated again" className="rounded p-0.5 hover:bg-slate-200" onClick={actions.onUnpin}>
                  <X className="size-3" />
                </button>
              )}
            </span>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="cursor-default rounded text-xs tabular-nums text-slate-600 underline decoration-dotted decoration-slate-300 underline-offset-4">
                {logged} of {plural(screens, "screen")} logged
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {plan ? "The stop is Done when every screen is, Incomplete when any is." : `Screens with a log entry dated ${visitDate || "the visit's day"}.`}
            </TooltipContent>
          </Tooltip>
        </div>
        <DialogDescription className="font-mono text-xs">{[stop.external_id || stop.display_id, stop.pa || project.pa, project.name].filter(Boolean).join(" · ")}</DialogDescription>
      </div>
      {(canMove || canSetAside || canRemove) && (
        <div role="group" aria-label="Plan actions" className="flex flex-wrap items-center gap-1.5">
          {canMove && (
            <Button size="sm" variant="outline" onClick={actions!.onMove}>
              <ArrowRightLeft /> {actions!.removed ? "Put back" : "Move"}
            </Button>
          )}
          {canSetAside && (
            <Button
              size="sm"
              variant="outline"
              className="text-amber-800"
              disabled={actions!.hasVisit}
              title={actions!.hasVisit ? "A store with a visit logged stays where it was visited" : "Off its day, kept with the plan as removed: an Admin puts it back or takes it out"}
              onClick={actions!.onSetAside}
            >
              <CalendarX /> Remove from day
            </Button>
          )}
          {canRemove && (
            <Button
              size="sm"
              variant="outline"
              className="text-rose-700"
              disabled={actions!.hasVisit}
              title={actions!.hasVisit ? "A store with a visit logged stays in the plan's history" : "Out of the plan for good: it can join another plan"}
              onClick={actions!.onRemove}
            >
              <Trash2 /> Remove from plan
            </Button>
          )}
        </div>
      )}
    </DialogHeader>
  );
}

/** "12 log entries · last 2026-11-20": the line over the store's log entries. */
function logSummary(pending: boolean, failed: boolean, dates: string[], more: boolean): string {
  if (pending) return "Loading…";
  if (failed) return "Could not load the log entries.";
  if (!dates.length) return "No log entries yet";
  const last = dates.reduce((latest, date) => (date > latest ? date : latest), "");
  return `${dates.length}${more ? "+" : ""} log ${dates.length === 1 && !more ? "entry" : "entries"} · last ${last}`;
}

const ALL_SCREENS = "all";

/** Every log entry of the store, newest first: each screen's, and the store's own comments (labelled Store). One
 *  screen, or the store's own, can be picked; entries of screens since deleted show under All screens. */
function LogEntries({ projectId, stop }: { projectId: string; stop: Stop }) {
  const [filter, setFilter] = useState(ALL_SCREENS);
  const visits = useVisits(projectId, stop.uid);
  const comments = useStoreComments(projectId, stop.uid);
  const dates = [...(visits.data?.items ?? []).map((visit) => visit.visit_date), ...(comments.data?.items ?? []).map((comment) => comment.visit_date)];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="text-sm text-slate-700">{logSummary(visits.isPending, visits.isError, dates, Boolean(visits.data?.next_cursor || comments.data?.next_cursor))}</p>
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger size="sm" aria-label="Filter by screen" className="min-w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_SCREENS}>All screens</SelectItem>
            <SelectItem value={STORE_ENTRIES}>Store</SelectItem>
            {stop.screens.map((screen, index) => (
              <SelectItem key={screen.id} value={screen.id}>
                {screenCodes(screen) || `Screen ${index + 1}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <VisitHistory projectId={projectId} stop={stop} bare screenId={filter === ALL_SCREENS ? undefined : filter} />
    </div>
  );
}

/** One screen's log, picked in the screens bar: what the screen is (DD code, stick, size, whose, brand, mount) and
 *  its pictures, then what this visit found (network, software, issue, comment) and what it left the screen as
 *  (Done or Incomplete). What is typed lives in the store's page (`value`), so it survives picking another screen.
 *  Save writes the screen's changes (pictures too) to the store and a log entry for it. */
function ScreenLog({
  stop,
  project,
  row,
  number,
  planId,
  who,
  readOnly,
  canEditDetails,
  updatedBy,
  value,
  dirty,
  onChange,
  onCreated,
  onSaved,
  onDiscard,
  onDelete,
}: {
  stop: Stop;
  project: Project;
  row: ScreenRow;
  number: number;
  planId: string;
  who: Who;
  /** Without `visits.log`: shown, nothing can be changed. */
  readOnly: boolean;
  /** The screen's details and pictures may be changed (`canEditStoreDetails`); else only the log is filled. */
  canEditDetails: boolean;
  /** Who the store records as changing the screens. */
  updatedBy: string;
  value: ScreenDraft;
  dirty: boolean;
  onChange: (change: (draft: ScreenDraft) => ScreenDraft) => void;
  /** A new screen got its id (it is on the store now, its log still open). */
  onCreated: (id: string) => void;
  onSaved: (screenId: string, withLog: boolean) => void;
  /** Drop what is typed (a new screen not saved yet goes away). */
  onDiscard: () => void;
  /** Absent when the screen cannot be deleted here (the last one, or not saved yet). */
  onDelete?: () => void;
}) {
  const categories = useCategories();
  const update = useUpdateScreens(project.id);
  const create = useCreateVisit(project.id, stop.uid);
  const draft = value.row ?? row;
  const { log, touched } = value;
  const setDraft = (change: (current: ScreenRow) => ScreenRow) => onChange((current) => ({ ...current, row: change(current.row ?? row) }));
  const setTouched = (next: boolean) => onChange((current) => ({ ...current, touched: next }));
  const venue = useVenue(draft.venue_id);
  const original = toRows(stop).find((item) => item.id !== undefined && item.id === draft.id);
  const detailsChanged = !original || !sameScreen(original, draft);
  const tree = categories.data ?? [];
  const subcategories = tree.find((entry) => entry.name === log.category)?.subcategories ?? [];
  const patch = (change: Partial<LogDraft>) => onChange((current) => ({ ...current, log: { ...current.log, ...change } }));

  const form = (screenId: string): VisitForm => ({
    screen_id: screenId,
    visit_date: who.visit_date,
    dd_code: draft.venue_id,
    // The CMS's name for the code; else what the sheet gave, else the store's name (the portal needs one).
    venue_name: venue.data?.screens[0]?.cms_name || draft.cms_name || venueNameOf(stop) || stop.store_name,
    stick_number: draft.stick_number,
    installer: who.installer,
    dolphin_manager: who.dolphin_manager,
    network_type: log.network_type,
    latest_apk: log.latest_apk,
    kiosk_mode: log.kiosk_mode,
    dagent_installed: log.dagent_installed,
    wifi_ssid: log.otherWifi ? log.wifi_ssid : "",
    wifi_password: log.otherWifi ? log.wifi_password : "",
    category: log.category,
    subcategory: log.subcategory,
    replaced_with: log.replaced_with,
    comments: log.comments,
    outcome: log.outcome,
  });
  const errors: Record<string, string> = { ...formErrors(form(draft.id ?? "new"), tree) };
  if (!log.outcome) errors.outcome = "Choose Done or Incomplete";
  if (log.network_type === "WiFi" && log.otherWifi && !log.wifi_ssid.trim()) errors.wifi_ssid = "Type the other WiFi's name, or untick the box";
  const shown = (key: string) => (touched ? errors[key] : undefined);
  const busy = update.isPending || create.isPending;

  const save = async (withLog: boolean) => {
    if (withLog) {
      setTouched(true);
      if (Object.keys(errors).length) return void toast.error(Object.values(errors)[0]!);
    }
    try {
      let screenId = draft.id;
      // Someone who may not change the screen sends no screens update (nothing could be changed anyway).
      if (detailsChanged && canEditDetails) {
        const all = toRows(stop);
        const index = all.findIndex((item) => item.id !== undefined && item.id === draft.id);
        const next = index >= 0 ? all.map((item, i) => (i === index ? draft : item)) : [...all, draft];
        const savedStop = await update.mutateAsync({ uid: stop.uid, screens: toInputs(next), updatedBy });
        screenId = savedStop.screens[index >= 0 ? index : next.length - 1]?.id;
        if (!screenId) throw new Error("The screen was not saved");
        if (!draft.id) onCreated(screenId);
        setDraft((current) => ({ ...current, id: screenId }));
      }
      if (withLog) {
        await create.mutateAsync(toInput(form(screenId!), planId));
        window.localStorage.setItem(MANAGER_KEY, who.dolphin_manager.trim());
        toast.success(`Screen ${number} logged · ${OUTCOME_LABEL[log.outcome as "done" | "incomplete"]}`);
      } else {
        toast.success(`Screen ${number} saved`);
      }
      onSaved(screenId!, withLog);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save");
    }
  };

  return (
    <>
    {/* One card for the screen: its Save bar on top, then each part under its own tinted strip (visitTone.ts). */}
    <div role="group" aria-label={`Log visit for screen ${number}`} className={SURFACE}>
      {/* Stays on top while the form scrolls: what the visit left the screen as, and Save. Its line is a shadow, so it
          sits on the first strip's top line rather than doubling it. */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-t-xl bg-white px-4 py-2.5 shadow-[0_1px_0_0_rgb(15_23_42/0.08)]">
        <h4 className="mr-auto flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-900">
          <VisitChip name="The screen" />
          <span>
            Screen {number} <span className="font-mono text-xs font-normal text-slate-600">{[draft.stick_number, draft.venue_id].filter(Boolean).join(" · ")}</span>
            {readOnly && <span className="ml-2 text-xs font-normal text-slate-600">View only</span>}
          </span>
        </h4>
        <div role="radiogroup" aria-label={`This visit leaves screen ${number}`} hidden={readOnly} className={cn("flex overflow-hidden rounded-lg border", shown("outcome") && "border-rose-400")}>
          {(["done", "incomplete"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={log.outcome === option}
              onClick={() => patch({ outcome: option })}
              className={cn(
                "h-10 px-4 text-sm font-medium",
                option === "incomplete" && "border-l",
                log.outcome === option ? (option === "done" ? "bg-emerald-600 text-white" : "bg-amber-500 text-white") : "bg-white text-slate-700 hover:bg-slate-50",
              )}
            >
              {OUTCOME_LABEL[option]}
            </button>
          ))}
        </div>
        {!readOnly && (
          <>
            <Button className="h-10 px-5" onClick={() => void save(true)} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Send />} Save log entry
            </Button>
            {row.id ? (
              <Button variant="ghost" onClick={onDiscard} disabled={busy || !dirty}>
                Discard changes
              </Button>
            ) : (
              <Button variant="ghost" onClick={onDiscard} disabled={busy}>
                Cancel
              </Button>
            )}
            {row.id && canEditDetails && (
              <Button
                size="icon"
                variant="ghost"
                className="size-9"
                aria-label={`Delete screen ${number}`}
                disabled={!onDelete || busy}
                title={onDelete ? undefined : "A store needs at least one screen"}
                onClick={onDelete}
              >
                <Trash2 />
              </Button>
            )}
          </>
        )}
      </div>
      <div className="min-w-0">
        {((touched && Object.keys(errors).length > 0) || (!readOnly && !canEditDetails)) && (
          <div className="space-y-2 border-t border-slate-100 px-4 py-3">
            {touched && Object.keys(errors).length > 0 && (
              <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                Still needed: {Object.values(errors).join(" · ")}
              </p>
            )}
            {!readOnly && !canEditDetails && (
              <p className="flex items-start gap-1.5 text-xs text-slate-600">
                <Lock className="mt-px size-3.5 shrink-0 text-slate-500" aria-hidden />
                This store is not on a route: you can log the visit, and an admin can change its screen details.
              </p>
            )}
          </div>
        )}

        <fieldset disabled={!canEditDetails} className="min-w-0">
          <div role="group" aria-label="The screen">
            <ToneStrip name="The screen" heading="h5" className="border-t">
              <div className="ml-auto flex items-center gap-2">
                <span className="text-[11px] text-sky-800">Status</span>
                <Select value={draft.status} onValueChange={(status) => setDraft((current) => ({ ...current, status: status as ScreenStatus }))}>
                  <SelectTrigger size="sm" aria-label={`Status of screen ${number}`} className={cn("h-7 border", STATUS_META[draft.status].chip)}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STOP_STATUSES.map((status) => (
                      <SelectItem key={status} value={status}>
                        {STATUS_META[status].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </ToneStrip>
            <div className="space-y-3 p-4">
              <ScreenFields row={draft} number={number} costs={project.hardware_costs} device={stop.screens.find((screen) => screen.id === draft.id)?.device} onPatch={(change) => setDraft((current) => ({ ...current, ...change }))} venueType={false} />
              {original && detailsChanged && canEditDetails && (
                <Button size="sm" variant="outline" onClick={() => void save(false)} disabled={busy}>
                  Save these details only (no log entry)
                </Button>
              )}
            </div>
          </div>
        </fieldset>

        <fieldset disabled={readOnly} className="min-w-0">
          <div role="group" aria-label="Network">
            <ToneStrip name="Network" heading="h5" className="border-t" />
            <div className="space-y-2 p-4">
              <Field label="Network" required error={shown("network_type")}>
                <div role="radiogroup" aria-label="Network Type" className="grid grid-cols-3 gap-3">
                  {NETWORK_TYPES.map((type) => {
                    const Icon = NETWORK_ICONS[type];
                    return (
                      <button
                        key={type}
                        type="button"
                        role="radio"
                        aria-checked={log.network_type === type}
                        onClick={() => patch({ network_type: type })}
                        className={cn("flex h-14 items-center justify-center gap-2 rounded-lg border-2 text-sm", log.network_type === type ? "border-brand bg-brand/10 text-brand" : "border-slate-200 text-slate-600")}
                      >
                        <Icon className="size-5" /> {type}
                      </button>
                    );
                  })}
                </div>
              </Field>
              {log.network_type === "WiFi" && (
                <div className="space-y-3">
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" className="size-4 accent-[var(--color-brand,#0F5B7C)]" checked={log.otherWifi} onChange={(e) => patch({ otherWifi: e.target.checked })} />
                    This screen is on a different WiFi
                  </label>
                  {log.otherWifi ? (
                    <div className="grid gap-4 @md:grid-cols-2">
                      <Field label="WiFi name (SSID) for this screen" error={shown("wifi_ssid")} htmlFor={`wifi-ssid-${row.key}`}>
                        <Input id={`wifi-ssid-${row.key}`} autoComplete="off" value={log.wifi_ssid} onChange={(e) => patch({ wifi_ssid: e.target.value })} />
                      </Field>
                      <Field label="WiFi password for this screen" htmlFor={`wifi-password-${row.key}`}>
                        <Input id={`wifi-password-${row.key}`} autoComplete="off" value={log.wifi_password} onChange={(e) => patch({ wifi_password: e.target.value })} />
                      </Field>
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500">
                      {stop.store_ssid ? `On the store's WiFi: ${stop.store_ssid}.` : "On the store's WiFi. None is on file yet: add it under Store WiFi on the right."}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          <div role="group" aria-label="Software">
            <ToneStrip name="Software" heading="h5" className="border-t" />
            <div className="grid items-end gap-4 p-4 @sm:grid-cols-3">
              <YesNo label="Latest APK" value={log.latest_apk} onChange={(latest_apk) => patch({ latest_apk })} error={shown("latest_apk")} />
              <YesNo label="Set Kiosk Mode" value={log.kiosk_mode} onChange={(kiosk_mode) => patch({ kiosk_mode })} error={shown("kiosk_mode")} />
              <YesNo label="Dagent installed" value={log.dagent_installed} onChange={(dagent_installed) => patch({ dagent_installed })} error={shown("dagent_installed")} />
            </div>
          </div>

          <div role="group" aria-label="Issue">
            <ToneStrip name="Issue" heading="h5" className="border-t" />
            <div className="space-y-4 p-4">
              <div className="grid gap-4 @sm:grid-cols-2">
                <Field label="Category" required error={shown("category")}>
                  <Select value={log.category} onValueChange={(category) => patch({ category, subcategory: "", replaced_with: "" })}>
                    <SelectTrigger aria-label="Category" className="w-full">
                      <SelectValue placeholder="Select category" />
                    </SelectTrigger>
                    <SelectContent>
                      {tree.map((entry) => (
                        <SelectItem key={entry.name} value={entry.name}>
                          {entry.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Subcategory" required error={shown("subcategory")}>
                  <Select value={log.subcategory} onValueChange={(subcategory) => patch({ subcategory })} disabled={!log.category}>
                    <SelectTrigger aria-label="Subcategory" className="w-full">
                      <SelectValue placeholder={log.category ? "Select subcategory" : "Pick a category first"} />
                    </SelectTrigger>
                    <SelectContent>
                      {subcategories.map((sub) => (
                        <SelectItem key={sub} value={sub}>
                          {sub}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                {REPLACED_WITH.has(log.subcategory) && (
                  <Field label="Replaced with" required error={shown("replaced_with")} htmlFor={`replaced-${row.key}`}>
                    <Input id={`replaced-${row.key}`} placeholder="New stick or screen number" value={log.replaced_with} onChange={(e) => patch({ replaced_with: e.target.value })} />
                  </Field>
                )}
              </div>
              <Field label="Comments for this screen" htmlFor={`comments-${row.key}`}>
                <Textarea id={`comments-${row.key}`} rows={3} placeholder="What was found and done" value={log.comments} onChange={(e) => patch({ comments: e.target.value })} />
              </Field>
            </div>
          </div>
        </fieldset>
      </div>
    </div>
    {/* The screen's pictures, a card of their own between the form and the map. The screen's own, not this visit's:
        they stay for later visits and show in the store window. Saved with the screen (the Save bar above). */}
    <section role="group" aria-label={`Pictures of screen ${number}`} className={cn(SURFACE, "overflow-hidden")}>
      <ToneStrip name="Pictures" heading="h4" title={`Pictures · screen ${number}`}>
        {draft.pictures.length > 0 && <span className={cn("text-xs tabular-nums", VISIT_TONE.Pictures.summary)}>{draft.pictures.length}</span>}
      </ToneStrip>
      <div className="p-4">
        <ScreenPictures
          pictures={draft.pictures}
          screen={number}
          onChange={canEditDetails ? (pictures) => setDraft((current) => ({ ...current, pictures })) : undefined}
        />
      </div>
    </section>
    </>
  );
}

/** The store on a small map under the screen's form, with a link to Google Maps. The map (a billed load) is drawn
 *  only once it scrolls into view, so opening the dialog loads none. */
function StoreMap({ stop }: { stop: Stop }) {
  const at = shownLocation(stop);
  return (
    <section aria-label="Store location" className={cn(SURFACE, "overflow-hidden")}>
      <ToneStrip name="Location" className="flex-nowrap">
        <span className={cn("min-w-0 truncate text-xs", VISIT_TONE.Location.summary)}>{[stop.addr, stop.city, stop.state].filter(Boolean).join(", ")}</span>
        {at && (
          <a
            href={`https://www.google.com/maps/search/?api=1&query=${at.lat},${at.lng}`}
            target="_blank"
            rel="noreferrer"
            className="ml-auto shrink-0 rounded text-xs text-brand hover:underline"
          >
            Open in Google Maps
          </a>
        )}
      </ToneStrip>
      <div className="p-3">
        {at ? (
          <WhenVisible placeholder={<div className="h-[220px] rounded-lg bg-slate-50" aria-hidden />}>
            <StoreLocationMap stop={stop} bare mapHeight="h-[220px]" />
          </WhenVisible>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-slate-600">
            <MapPinOff className="size-3.5" aria-hidden /> No map location
          </p>
        )}
      </div>
    </section>
  );
}

/** A comment on the store as a whole (each screen's own goes on its log entry). Folded away by default: it is
 *  rarely needed while logging screens. Each save is a log entry of its own (who, when, from which plan, under
 *  Logs as Store) and the store's comment, which the rest of the app reads. Emptying the box only clears that. */
function StoreComment({ stop, projectId, planId, who, readOnly }: { stop: Stop; projectId: string; planId: string; who: Who; readOnly: boolean }) {
  const clear = useUpdateProgress(projectId);
  const log = useCreateStoreComment(projectId, stop.uid);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(stop.comment ?? "");
  const changed = text.trim() !== (stop.comment ?? "").trim();
  const busy = clear.isPending || log.isPending;
  const save = async () => {
    try {
      if (text.trim()) {
        await log.mutateAsync({ text: text.trim(), visit_date: who.visit_date || todayIso(), installer: who.installer.trim(), dolphin_manager: who.dolphin_manager.trim(), route_plan_id: planId });
        toast.success("Store comment logged");
      } else {
        await clear.mutateAsync({ uid: stop.uid, body: { comment: "" } });
        toast.success("Store comment cleared");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the comment");
    }
  };
  return (
    <div role="group" aria-label="Comment on the store" className={cn(SURFACE, "overflow-hidden")}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="store-comment-box"
        onClick={() => setOpen(!open)}
        className={cn(
          "flex min-h-10 w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none",
          VISIT_TONE["Store comment"].strip,
          VISIT_TONE["Store comment"].hover,
        )}
      >
        <ChevronRight className={cn("size-3.5 shrink-0 text-slate-500 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
        <VisitChip name="Store comment" />
        <span className={cn(TONE_TITLE, "shrink-0", VISIT_TONE["Store comment"].title)}>Store comment</span>
        {!open && <span className={cn("min-w-0 truncate", VISIT_TONE["Store comment"].summary)}>{stop.comment ? `· ${stop.comment}` : "· none"}</span>}
      </button>
      {open && (
        <div id="store-comment-box" className={cn("space-y-2 border-t p-3", VISIT_TONE["Store comment"].line)}>
          <Label htmlFor="store-comment" className="sr-only">
            Store comment
          </Label>
          <Textarea id="store-comment" rows={3} disabled={readOnly} placeholder="Anything about the store as a whole" value={text} onChange={(e) => setText(e.target.value)} className="text-sm" />
          {!readOnly && (
            <div className="space-y-1.5">
              <Button size="sm" onClick={() => void save()} disabled={!changed || busy}>
                {busy && <Loader2 className="animate-spin" />} Save comment
              </Button>
              <p className="text-[11px] text-slate-600">Kept under Logs as a Store entry, with who and when.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface LockedField {
  key: LockedKey;
  label: string;
  secret?: boolean;
}

/** A few store fields shown locked; its own Edit button unlocks them, so a change is always deliberate. Saving
 *  updates the store. */
function LockedGroup({ stop, projectId, title, fields, canEdit, stacked = false }: { stop: Stop; projectId: string; /** Also picks its hue. */ title: Extract<VisitToneName, "Store WiFi" | "Owner" | "Store Contact">; fields: readonly LockedField[]; /** `canEditStoreDetails`: else no Edit. */ canEdit: boolean; /** One field per line (the narrow side panel). */ stacked?: boolean }) {
  const keys = fields.map((field) => field.key);
  const [editing, setEditing] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [form, setForm] = useState<LockedValues>(() => lockedValues(stop, keys));
  const update = useUpdateStoreDetails(projectId);
  useEffect(() => {
    if (!editing) setForm(lockedValues(stop, keys)); // `keys` comes from a static field list
  }, [stop, editing]);

  const save = async () => {
    const patch = lockedPatch(stop, form);
    if (!Object.keys(patch).length) {
      setEditing(false);
      return;
    }
    try {
      await update.mutateAsync({ uid: stop.uid, body: patch });
      toast.success(`${title} updated on the store`);
      setEditing(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not update ${title.toLowerCase()}`);
    }
  };

  return (
    <div role="group" aria-label={title} className={cn(SURFACE, "overflow-hidden")}>
      <ToneStrip name={title} title={<span className="flex items-center gap-1.5">{title} {!editing && <Lock className="size-3 text-slate-500" aria-label="locked" />}</span>}>
        {editing ? (
          <div className="ml-auto flex gap-1.5">
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" className="h-7" onClick={() => void save()} disabled={update.isPending} aria-label={`Save ${title}`}>
              {update.isPending && <Loader2 className="animate-spin" />} Save
            </Button>
          </div>
        ) : !canEdit ? null : (
          <Button size="sm" variant="outline" className="ml-auto h-7" onClick={() => setEditing(true)} aria-label={`Edit ${title}`}>
            <Pencil /> Edit
          </Button>
        )}
      </ToneStrip>
      {!editing && (
        // Read as text, like the Store card above: nothing looks typeable until Edit.
        <dl className="space-y-1.5 p-4">
          {fields.map(({ key, label, secret }) => {
            const value = form[key] ?? "";
            return (
              <div key={key} className="grid grid-cols-[minmax(0,140px)_minmax(0,1fr)] gap-2">
                <dt className="text-xs text-slate-500">{label}</dt>
                <dd aria-label={label} className="flex min-w-0 items-center gap-1.5 text-sm font-medium break-words text-slate-900">
                  {!value ? (
                    <span className="font-normal text-slate-300">—</span>
                  ) : secret ? (
                    <>
                      <span className="font-mono">{reveal ? value : "••••••••"}</span>
                      <button type="button" className="relative text-slate-500 after:absolute after:-inset-2 hover:text-slate-800" aria-label={reveal ? `Hide ${label}` : `Show ${label}`} onClick={() => setReveal(!reveal)}>
                        {reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      </button>
                    </>
                  ) : (
                    value
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      <div hidden={!editing} className={cn("grid p-4", stacked ? "gap-3 @md:grid-cols-2" : "gap-4 sm:grid-cols-3")}>
        {editing && fields.map(({ key, label, secret }) => (
          <Field key={key} label={label} htmlFor={`locked-${key}`}>
            <div className="relative">
              <Input
                id={`locked-${key}`}
                type={secret && !reveal ? "password" : "text"}
                autoComplete="off"
                value={form[key] ?? ""}
                readOnly={!editing}
                className={cn(!editing && "bg-slate-50 text-slate-600", secret && "pr-9")}
                onChange={(e) => setForm((current) => ({ ...current, [key]: e.target.value }))}
              />
              {secret && (
                <button
                  type="button"
                  className="absolute top-1/2 right-2.5 -translate-y-1/2 text-slate-500"
                  aria-label={reveal ? `Hide ${label}` : `Show ${label}`}
                  onClick={() => setReveal(!reveal)}
                >
                  {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              )}
            </div>
          </Field>
        ))}
      </div>
    </div>
  );
}

const SIDE_GROUPS = ["Site notes", "Site checklist", "Installation", "Identity & address", "Pictures"] as const satisfies readonly StoreFieldSpec["group"][];
const ON_FORM = new Set(["store_name", "addr", "city", "state", "zip", "pa", "owner_name", "owner_phone", "owner_email", "onsite_contact_name", "onsite_contact_phone", "store_ssid", "store_ssid_password"]);

function display(spec: StoreFieldSpec, value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (spec.kind === "bool" || spec.kind === "tristate") return value ? "Yes" : "No";
  return String(value);
}

/** Everything else the sheet gave us, read only: WiFi first, then site notes, checklist, installation, other data. */
function StoreSideNotes({ stop, project }: { stop: Stop; project: Project }) {
  const specs = useStoreFields();
  const labels = useMemo(() => new Map(project.field_schema.map((field) => [field.key, field.label])), [project.field_schema]);
  const groups = useMemo(() => {
    const record = stop as unknown as Record<string, unknown>;
    return SIDE_GROUPS.map((group) => ({
      group,
      rows: (specs.data ?? [])
        .filter((spec) => spec.group === group && !ON_FORM.has(spec.name))
        .map((spec) => ({ spec, value: display(spec, record[spec.name]) }))
        .filter((row) => row.value),
    })).filter((entry) => entry.rows.length);
  }, [specs.data, stop]);
  const extra = Object.entries(stop.fields ?? {}).filter(([, value]) => value !== null && value !== "");

  return (
    <div className="space-y-3 text-sm">
      {/* A label between the cards, on the pane: each group below is its own card in the store window's hue. */}
      <h3 className="px-1 pt-1 font-mono text-[11px] uppercase tracking-wider text-slate-600">From the sheet (read only)</h3>
      {groups.length === 0 && extra.length === 0 && <p className={cn(SURFACE, "px-4 py-3 text-xs text-slate-600")}>Nothing else on file for this store.</p>}
      {groups.map(({ group, rows }) => (
        <section key={group} aria-label={group} className={cn(SURFACE, "overflow-hidden")}>
          <ToneStrip name={group} />
          {group === "Pictures" ? (
            // The store's pictures themselves (click one to enlarge), not their links.
            <div className="p-4">
              <ImagePreviews label="Store pictures" urls={rows.flatMap((row) => urlTokens(row.value))} />
            </div>
          ) : (
          <dl className="space-y-1 p-4">
            {rows.map(({ spec, value }) => (
              <div key={spec.name} className="grid grid-cols-[120px_minmax(0,1fr)] gap-2">
                <dt className="text-xs text-slate-600">{spec.label}</dt>
                <dd className="break-words text-xs">
                  {spec.kind === "url" ? (
                    value.split(/\s+/).filter((token) => token.startsWith("http")).map((url) => (
                      <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="block truncate text-brand underline">
                        {url}
                      </a>
                    ))
                  ) : (
                    <span className="whitespace-pre-wrap">{value}</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          )}
        </section>
      ))}
      {extra.length > 0 && (
        <section aria-label="Other imported data" className={cn(SURFACE, "overflow-hidden")}>
          <ToneStrip name="Other imported data" />
          <dl className="space-y-1 p-4">
            {extra.map(([key, value]) => (
              <div key={key} className="grid grid-cols-[120px_minmax(0,1fr)] gap-2">
                <dt className="text-xs text-slate-600">{labels.get(key) ?? key}</dt>
                <dd className="break-words text-xs whitespace-pre-wrap">{String(value)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}

/** `screenId` for the store's own entries (its comments) only. */
export const STORE_ENTRIES = "store";

export type LogEntry = { kind: "visit"; at: string; visit: Visit } | { kind: "store"; at: string; comment: StoreComment };

/** The screens' visits and the store's own entries as one list, newest logged first. `filter`: a screen's id (its
 *  visits only), `STORE_ENTRIES` (the store's only), or nothing for every entry. */
export function logEntries(visits: Visit[], comments: StoreComment[], filter?: string): LogEntry[] {
  const entries: LogEntry[] = [
    ...(filter === STORE_ENTRIES ? [] : visits.filter((visit) => !filter || visit.screen_id === filter).map((visit) => ({ kind: "visit" as const, at: visit.created_at, visit }))),
    ...(filter && filter !== STORE_ENTRIES ? [] : comments.map((comment) => ({ kind: "store" as const, at: comment.created_at, comment }))),
  ];
  return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** Who logged a store entry: the technician and manager as the visit row had them, else whoever was signed in. */
const commentBy = (comment: StoreComment) =>
  [comment.installer, comment.dolphin_manager && `managed by ${comment.dolphin_manager}`].filter(Boolean).join(" · ") || (comment.created_by ? `by ${comment.created_by}` : "");

/** The store's servicing history, newest first: every visit with its stick, and the store's own comments
 *  (labelled Store). */
export function VisitHistory({ projectId, stop, bare = false, screenId }: { projectId: string; stop: Stop; bare?: boolean; /** Only this screen's entries (`STORE_ENTRIES`: the store's own). */ screenId?: string }) {
  const visits = useVisits(projectId, stop.uid);
  const comments = useStoreComments(projectId, stop.uid);
  const items = logEntries(visits.data?.items ?? [], comments.data?.items ?? [], screenId);
  const stickLabel = (visit: Visit) => {
    const index = stop.screens.findIndex((screen) => screen.id === visit.screen_id);
    return index >= 0 ? `Stick ${index + 1}` : "Removed stick";
  };
  const Wrapper = bare ? "div" : "section";
  return (
    <Wrapper aria-label={bare ? undefined : "Servicing history"} className={cn("space-y-2", !bare && "border-t pt-4")}>
      {!bare && <h3 className="font-mono text-[11px] uppercase tracking-wider text-slate-500">Servicing history</h3>}
      {visits.isPending || comments.isPending ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : visits.isError ? (
        <p className="text-xs text-rose-700">Could not load the history.</p>
      ) : (
        <>
          {comments.isError && <p className="text-xs text-rose-700">Could not load the store's own entries.</p>}
          {items.length === 0 ? (
            <p className="text-xs text-slate-500">{screenId === STORE_ENTRIES ? "No store comments logged yet." : screenId ? "No log entries for this screen yet." : "No visits logged yet."}</p>
          ) : (
            <ol className="space-y-2">
              {items.map((entry) =>
                entry.kind === "store" ? (
                  <li key={`store-${entry.comment.id}`} className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs">
                    <div className="flex flex-wrap items-baseline justify-between gap-1">
                      <span className="flex items-center gap-1.5 font-semibold">
                        {entry.comment.visit_date}
                        <span className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-1 py-px text-[10px] font-medium text-slate-700">
                          <Store className="size-2.5" /> Store
                        </span>
                      </span>
                      {entry.comment.plan_name && (
                        <span className="font-mono text-[10px] text-slate-500">
                          {entry.comment.plan_name}
                          {entry.comment.plan_day ? ` · day ${entry.comment.plan_day}` : ""}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-slate-800">{entry.comment.text}</p>
                    {commentBy(entry.comment) && <div className="mt-0.5 text-slate-500">{commentBy(entry.comment)}</div>}
                  </li>
                ) : (
                  <li key={entry.visit.id} className="rounded-lg border p-2.5 text-xs">
                    <div className="flex flex-wrap items-baseline justify-between gap-1">
                      <span className="font-semibold">
                        {entry.visit.visit_date}
                        {entry.visit.outcome && <span className={cn("ml-1.5 rounded border px-1 py-px text-[10px] font-medium", OUTCOME_TONE[entry.visit.outcome])}>{OUTCOME_LABEL[entry.visit.outcome]}</span>}
                      </span>
                      <span className="font-mono text-[10px] text-slate-500">
                        {stickLabel(entry.visit)} · {entry.visit.stick_number} · {entry.visit.dd_code}
                      </span>
                    </div>
                    <div className="mt-1">
                      {entry.visit.category} › {entry.visit.subcategory}
                      {entry.visit.replaced_with ? ` → ${entry.visit.replaced_with}` : ""}
                    </div>
                    <div className="mt-0.5 text-slate-500">
                      {entry.visit.installer} · managed by {entry.visit.dolphin_manager} · {entry.visit.network_type} · APK {entry.visit.latest_apk ? "yes" : "no"} · Kiosk{" "}
                      {entry.visit.kiosk_mode ? "yes" : "no"} · Dagent {entry.visit.dagent_installed ? "yes" : "no"}
                      {entry.visit.wifi_ssid ? ` · on WiFi "${entry.visit.wifi_ssid}"` : ""}
                    </div>
                    {entry.visit.comments && <p className="mt-1 whitespace-pre-wrap text-slate-700">{entry.visit.comments}</p>}
                  </li>
                ),
              )}
            </ol>
          )}
        </>
      )}
    </Wrapper>
  );
}
