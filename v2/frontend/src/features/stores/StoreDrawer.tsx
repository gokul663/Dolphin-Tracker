import { useCan } from "@/lib/auth/me";
import { useState } from "react";
import { Link } from "react-router";
import { useRoutePlans } from "@/features/planner/api";
import { VisitHistory, VisitPanel } from "@/features/visits/VisitPanel";
import { AlertTriangle, BadgeCheck, CheckCircle2, CircleSlash, ChevronRight, X, ClipboardCheck, ChevronsDownUp, ChevronsUpDown, Eye, EyeOff, Loader2, MapPin, Route, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { TriStateCheckbox } from "@/components/TriStateCheckbox";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useStoreFields, useValidateAddress } from "@/features/places/api";
import { GoogleSearchPicker } from "@/features/places/GoogleSearchPicker";
import type { PlaceHit } from "@/lib/api/types";
import { screensChanged, ScreensEditor, ScreensView, toInputs, toRows, type ScreenRow } from "@/features/stores/ScreensEditor";
import { deviceDifferences, StoreDeviceSection } from "@/features/device/StoreDeviceSection";
import { StoreLogs } from "@/features/device/StoreLogs";
import { reportDay, splitCodes } from "@/features/device/DeviceBits";
import { shownLocation, StoreLocationMap } from "@/components/map/StoreLocationMap";
import { WhenVisible } from "@/components/WhenVisible";
import { ImagePreviews } from "@/features/stores/Pictures";
import { COUNT_KEYS, NO_TECHNICIAN, StoreSummary, type SummaryDraft } from "@/features/stores/StoreSummary";
import { MismatchNotice, StoreTagPicker } from "@/features/stores/StoreFlags";
import { EditToggle, ToneChip } from "@/features/stores/SectionChrome";
import { SECTION_TONE } from "@/features/stores/sectionTone";
import { useDeleteStore, useFilterOptions, useSetExternalId, useStore, useUpdateProgress, useUpdateScreens, useUpdateStoreDetails } from "@/features/stores/api";
import {
  addressChanged,
  detailsErrors,
  detailsFormFrom,
  detailsPatch,
  filledCount,
  type DetailsForm,
  type FormValue,
} from "@/features/stores/details";
import { ApiError, type OverwriteField, type ProgressUpdate, type Project, type Stop, type StoreFieldSpec } from "@/lib/api/types";
import { STATUS_META, storeStatusLabel } from "@/lib/status";
import { cn, SURFACE } from "@/lib/utils";
import { urlTokens } from "@/lib/validation/storeFields";

interface Props {
  project: Project;
  stopId: string | null;
  open: boolean;
  onClose: () => void;
}

type Group = StoreFieldSpec["group"];
/** Every collapsible section, in order: on the left what gets edited on site, on the right the reference material
 *  (the Dolphin data comparison sits after WiFi and is not collapsible: it shows only while something differs). */
const SECTIONS = [
  "Identity & address", "Screens", "Notes", "Pictures", "Location",
  "WiFi", "Contacts", "Installation", "Site notes", "Site checklist", "Other imported data",
] as const;
type SectionName = (typeof SECTIONS)[number];
/** Every section starts open, so the window reads top to bottom without a click; each still collapses, its header
 *  then saying what is inside ("3 of 7 filled", "2 pictures", "empty"). */
const DEFAULT_OPEN: readonly SectionName[] = SECTIONS;
/** The two exceptions: Notes and Pictures open only when the store has some. Empty, they are just blank boxes in the
 *  way; their header says "empty" and one click opens them. */
function hasContent(stop: Stop): Partial<Record<SectionName, boolean>> {
  return {
    Notes: Boolean(stop.comment.trim() || stop.review_notes.trim()),
    Pictures: urlTokens(stop.image_url).length > 0,
  };
}
/** The right-hand column: reference material, still editable but out of the way of address and screens. */
const ASIDE_GROUPS: (Group & SectionName)[] = ["WiFi", "Contacts", "Installation", "Site notes", "Site checklist"];

interface Sections {
  isOpen: (name: SectionName) => boolean;
  toggle: (name: SectionName) => void;
  /** Opened by its Edit button, so it stays open after View. */
  open: (name: SectionName) => void;
}

/** The header's information chips: status, Dolphin data, anything to fix, the route. One shape, 28 px high. */
const CHIP = "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium";

/** Full editor for one store in a large modal, in two columns like the visit log: on the left what gets edited on
 *  site (address, then the screens right under it, then the manager's notes); on the right the
 *  reference material (pictures, WiFi, Dolphin data, contacts, installation, site notes and checklist, other
 *  imported data), which a switch swaps for the logs (the CMS's servicing log and the visits logged here). Every section stays collapsible and editable. */
export function StoreDrawer({ project, stopId, open, onClose }: Props) {
  const canLog = useCan("visits.log");
  const store = useStore(project.id, open ? stopId : null);
  const specs = useStoreFields();
  const stop = store.data;
  // Kept across stores: a user who collapses Contacts once keeps it collapsed for the next store.
  const [expanded, setExpanded] = useState<Set<SectionName>>(() => new Set(DEFAULT_OPEN));
  const sections: Sections = {
    isOpen: (name) => expanded.has(name),
    toggle: (name) =>
      setExpanded((current) => {
        const next = new Set(current);
        if (!next.delete(name)) next.add(name);
        return next;
      }),
    open: (name) => setExpanded((current) => (current.has(name) ? current : new Set([...current, name]))),
  };
  const allOpen = expanded.size === SECTIONS.length;
  // On each store: Notes and Pictures open when it has some, closed when not (see hasContent). Set once per store,
  // while rendering, so the window never shows the other state first; after that the person's clicks decide.
  const [fittedTo, setFittedTo] = useState("");
  if (stop && stop.uid !== fittedTo) {
    setFittedTo(stop.uid);
    const filled = hasContent(stop);
    setExpanded((current) => {
      const next = new Set(current);
      for (const [name, has] of Object.entries(filled) as [SectionName, boolean][]) {
        if (has) next.add(name);
        else next.delete(name);
      }
      return next;
    });
  }
  const [logging, setLogging] = useState(false);
  const canDelete = useCan("stores.delete"); // admins
  const remove = useDeleteStore(project.id);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deleteStore = () => {
    if (!stop) return;
    const name = stop.store_name || stop.external_id || stop.display_id;
    remove.mutate(stop.uid, {
      onSuccess: () => {
        toast.success(`Deleted ${name}`);
        onClose();
      },
      onError: (error) => toast.error(error instanceof Error ? error.message : "Could not delete the store"),
      onSettled: () => setConfirmingDelete(false),
    });
  };
  const plans = useRoutePlans("active");
  // Everyone already assigned somewhere in the project, offered when assigning this store.
  // Only once the window is open: closed, it would read every store of the project on each page load for nothing.
  const options = useFilterOptions(project.id, {}, open);
  const technicians = (options.data?.technician ?? []).map((option) => option.value).filter(Boolean);
  const planNames = new Map((plans.data ?? []).map((plan) => [plan.id, plan.name]));
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      {/* The window is glass over the dimmed page; its header and Save bar a near-white glass bar; every section a
          solid card on it (index.css, .glass-pane / .glass-bar). */}
      <DialogContent
        showCloseButton={false}
        className="glass-pane flex max-h-[94vh] w-[90vw] max-w-[90vw] flex-col gap-0 overflow-hidden rounded-[22px] p-0 sm:max-w-[90vw]"
      >
        <DialogHeader className="glass-bar z-10 gap-0 border-b border-(--glass-bar-line) px-6 py-4 text-left sm:text-left">
          <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
            {/* Left: what the store is and where it stands. */}
            <div className="min-w-0 flex-[1_1_26rem] space-y-2.5">
              <DialogTitle className="font-mono text-base leading-snug uppercase tracking-wider text-brand [overflow-wrap:anywhere]">
                {stop ? `${stop.external_id || stop.display_id} · ${stop.store_name}` : "Store"}
              </DialogTitle>
              <DialogDescription asChild>
                <div role="group" aria-label="Store standing" className="flex flex-wrap items-center gap-1.5">
                  {stop && <span className={cn(CHIP, STATUS_META[stop.status].chip)}>{storeStatusLabel(stop.status)}</span>}
                  {stop && <StoreAlerts project={project} stop={stop} />}
                  {stop && <RouteChip stop={stop} planName={stop.route_plan_id ? planNames.get(stop.route_plan_id) : undefined} />}
                </div>
              </DialogDescription>
            </div>
            {/* Right: what can be done: the manager's tag, Log visit, Delete, expand / collapse every section, close. */}
            <div role="group" aria-label="Store actions" className="ml-auto flex flex-wrap items-center justify-end gap-2">
              {stop && <StoreTagPicker project={project} stop={stop} />}
              {stop && canLog && (
                <Button type="button" variant="outline" onClick={() => setLogging(true)}>
                  <ClipboardCheck /> Log visit
                </Button>
              )}
              {stop && canDelete && (
                <Button
                  type="button"
                  variant="outline"
                  className="border-rose-200 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                  onClick={() => setConfirmingDelete(true)}
                >
                  <Trash2 /> Delete store
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={allOpen ? "Collapse all" : "Expand all"}
                title={allOpen ? "Collapse every section" : "Expand every section"}
                onClick={() => setExpanded(new Set(allOpen ? [] : SECTIONS))}
              >
                {allOpen ? <ChevronsDownUp /> : <ChevronsUpDown />}
              </Button>
              <DialogClose asChild>
                <Button type="button" variant="ghost" size="icon" aria-label="Close" title="Close (Esc)">
                  <X />
                </Button>
              </DialogClose>
            </div>
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6">
          {(store.isPending || specs.isPending) && open && <p className="py-4 text-sm text-slate-500">Loading…</p>}
          {store.isError && <p className="py-4 text-sm text-rose-700">{store.error.message}</p>}
          {specs.isError && <p className="py-4 text-sm text-rose-700">Could not load the store fields: {specs.error.message}</p>}
          {stop && specs.data && (
            // Re-keyed when an Overwrite from the Dolphin data changes the saved values, so the form shows them.
            <DetailsEditor
              key={`${stop.uid}-details-${[stop.store_name, stop.addr, stop.city, stop.state, stop.zip, stop.lat, stop.lng].join("|")}`}
              project={project}
              stop={stop}
              specs={specs.data}
              sections={sections}
              technicians={[...project.installers, ...technicians]}
              aside={<OtherData project={project} stop={stop} sections={sections} />}
              logs={
                // Under Logs, after the CMS's entries: the visits logged in this app for the store.
                <section aria-label="Servicing history" className={cn(SURFACE, "p-4")}>
                  <h3 className="mb-2 font-mono text-[11px] uppercase tracking-wider text-slate-600">Visits logged here</h3>
                  <VisitHistory projectId={project.id} stop={stop} bare />
                </section>
              }
            />
          )}
        </div>
      </DialogContent>
      <VisitPanel
        projectId={logging && stop ? project.id : null}
        stopUid={logging && stop ? stop.uid : null}
        planId={stop?.route_plan_id ?? ""}
        onClose={() => setLogging(false)}
      />
      <ConfirmDialog
        open={confirmingDelete}
        title="Are you sure?"
        confirmLabel="Delete store"
        busy={remove.isPending}
        onConfirm={deleteStore}
        onCancel={() => setConfirmingDelete(false)}
      >
        {stop && (
          <>
            <p>
              Delete <strong>{stop.store_name || stop.display_id}</strong>
              {stop.external_id ? ` (${stop.external_id})` : ""}? The store, its {stop.screens.length}{" "}
              {stop.screens.length === 1 ? "screen" : "screens"} and its visit history are removed for good. This cannot
              be undone.
            </p>
            {stop.route_plan_id && (
              <p className="mt-2 text-amber-800">This store is in a route plan: take it out of the plan first.</p>
            )}
          </>
        )}
      </ConfirmDialog>
    </Dialog>
  );
}

/** The store's standing at a glance, beside its name: whether it matches the Dolphin data, and anything that needs
 *  fixing (an unverified address, a DD code entry holding several codes, no ExtID or name). */
function StoreAlerts({ project, stop }: { project: Project; stop: Stop }) {
  const day = project.device_sync?.snapshot_date ?? stop.device?.date ?? "";
  const missing = stop.needs_attention.includes("not_reporting");
  const differs = deviceDifferences(stop).length;
  const verified = Boolean(stop.geocoded) && stop.lat !== null && !stop.needs_attention.includes("address");
  const clubbed = stop.screens.filter((screen) => splitCodes(screen.venue_id).length > 1).length;
  const pill = (tone: string, text: string, icon: React.ReactNode, title?: string) => (
    <span key={text} className={cn(CHIP, tone)} title={title}>
      {icon}
      {text}
    </span>
  );
  const ok = "border-cyan-200 bg-cyan-50 text-cyan-800";
  const warn = "border-amber-300 bg-amber-50 text-amber-800";
  const bad = "border-rose-200 bg-rose-50 text-rose-700";
  const sync = missing
    ? pill(bad, "Not in Dolphin data", <AlertTriangle size={12} />, "Completed, but its DD code is missing from the latest Dolphin data")
    : stop.device
      ? differs
        ? pill(warn, `Differs from Dolphin data (${differs})`, <AlertTriangle size={12} />, "The Dolphin data shows on the map and in the list; overwrite the sheet's values under Dolphin data")
        : pill(ok, `Synced with Dolphin data${day ? ` · ${reportDay(day)}` : ""}`, <CheckCircle2 size={12} />)
      : project.device_pa
        ? pill("border-slate-200 bg-slate-50 text-slate-600", "Not synced with Dolphin data", <CircleSlash size={12} />, "None of its DD codes is in the Dolphin data")
        : null;
  return (
    <span className="contents" aria-label="Store alerts">
      {sync}
      {!verified && pill(warn, "Address not verified", <MapPin size={12} />)}
      {clubbed > 0 && pill(warn, clubbed === 1 ? "DD code holds several codes" : `${clubbed} DD codes hold several codes`, <AlertTriangle size={12} />, "Split them under Screens so each matches its device")}
      {!stop.external_id && pill(warn, "No ExtID", <AlertTriangle size={12} />)}
      {stop.needs_attention.includes("store_name") && pill(warn, "No store name", <AlertTriangle size={12} />)}
    </span>
  );
}

/** The route the store is in (a link to its plan), or "Not in a route": information, so a chip with the others. The
 *  link's hit area reaches 36 px though the chip is 28. */
function RouteChip({ stop, planName }: { stop: Stop; planName?: string }) {
  if (!stop.route_plan_id) {
    return (
      <span className={cn(CHIP, "border-slate-200 bg-white text-slate-600")}>
        <Route size={12} aria-hidden /> Not in a route
      </span>
    );
  }
  return (
    <Link
      to={`/planner/${stop.route_plan_id}`}
      title="Open the route plan"
      className={cn(CHIP, "relative border-blue-200 bg-blue-50 text-blue-800 after:absolute after:inset-x-0 after:-inset-y-1 hover:bg-blue-100 hover:underline")}
    >
      <Route size={12} aria-hidden /> In route: {planName ?? "open the plan"}
    </Link>
  );
}

/** A collapsible section, as its own card. Closed content stays mounted (hidden), so unsaved edits inside it survive
 *  a collapse (`lazy` skips that for content with nothing to lose, like the map); `forceOpen` keeps a section being
 *  edited or with a validation problem visible. The header says what is inside (`summary`) while it is closed. */
function Section({
  title,
  sections,
  summary,
  forceOpen = false,
  lazy = false,
  className,
  action,
  children,
}: {
  title: SectionName;
  sections: Sections;
  /** What is inside, in a few words, on the right of the title. */
  summary?: string;
  forceOpen?: boolean;
  lazy?: boolean;
  className?: string;
  /** A button or link beside the title (Edit / View, Open in Google Maps). */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const open = forceOpen || sections.isOpen(title);
  const bodyId = `store-section-${title.replace(/\W+/g, "-").toLowerCase()}`;
  // The section's hue (sectionTone.ts): an icon chip, the title, and a light tint on the header strip.
  const tone = SECTION_TONE[title];
  return (
    <section className={cn(SURFACE, "overflow-hidden", className)} aria-label={title}>
      <div className={cn("flex items-center gap-2 pr-3 transition-colors motion-reduce:transition-none", tone.header)}>
        <h3 className="min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => sections.toggle(title)}
            className="flex min-h-11 w-full items-center gap-2 py-2 pr-2 pl-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <ChevronRight size={14} aria-hidden className={cn("shrink-0 text-slate-500 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
            <ToneChip name={title} />
            <span className={cn("font-mono text-[11px] font-medium uppercase tracking-wider", tone.title)}>{title}</span>
            {summary && <span className={cn("ml-auto min-w-0 truncate pl-2 text-xs", tone.summary)}>{summary}</span>}
          </button>
        </h3>
        {action}
      </div>
      <div id={bodyId} hidden={!open} className={cn("space-y-3 border-t p-4", tone.line)}>
        {lazy && !open ? null : children}
      </div>
    </section>
  );
}

/** A value as a line item: Yes/No for checks, links for URLs, dots for the WiFi password (with a reveal). */
function DetailValue({ spec, value }: { spec: StoreFieldSpec; value: unknown }) {
  const [shown, setShown] = useState(false);
  if (value === null || value === undefined || value === "") return <span className="font-normal text-slate-400">—</span>;
  if (spec.kind === "bool" || spec.kind === "tristate") return <span>{value ? "Yes" : "No"}</span>;
  if (spec.name === "store_ssid_password") {
    return (
      <span className="flex items-center gap-1.5">
        <span className="font-mono">{shown ? String(value) : "••••••••"}</span>
        <button type="button" className="text-slate-500 hover:text-slate-800" aria-label={shown ? "Hide password" : "Show password"} onClick={() => setShown(!shown)}>
          {shown ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
      </span>
    );
  }
  if (spec.kind === "url") {
    return (
      <>
        {urlTokens(String(value)).map((url) => (
          <a key={url} href={url} target="_blank" rel="noreferrer" className="block truncate text-brand hover:underline">
            {url}
          </a>
        ))}
      </>
    );
  }
  return <span className="whitespace-pre-wrap">{String(value)}</span>;
}

/** One section in the visit log's style, as a collapsible card: every field as a label / value line; Edit turns it
 *  into its form and View back into lines. Both show the draft (the window's Save sends it, Discard drops it), so View
 *  never loses an edit. */
function DetailPanel({
  group,
  stop,
  project,
  specs,
  sections,
  summary,
  editing,
  forced = false,
  values,
  onEdit,
  onView,
  children,
}: {
  group: Group & SectionName;
  stop: Stop;
  project: Project;
  specs: StoreFieldSpec[];
  sections: Sections;
  summary?: string;
  editing: boolean;
  /** Kept in edit mode (a value there is invalid). */
  forced?: boolean;
  /** The draft's values, shown as the lines. */
  values: DetailsForm;
  onEdit: () => void;
  onView: () => void;
  /** The section's form controls, shown while editing. */
  children: React.ReactNode;
}) {
  const record = stop as unknown as Record<string, unknown>;
  const valueOf = (spec: StoreFieldSpec) => (spec.name === "pa" ? stop.pa || project.pa : spec.name in values ? values[spec.name] : record[spec.name]);
  const editable = specs.some((spec) => spec.editable);
  const pictures = group === "Pictures" ? urlTokens(String(values.image_url ?? stop.image_url)) : [];
  return (
    <Section
      title={group}
      sections={sections}
      summary={summary}
      forceOpen={editing}
      // Being edited: a brand ring round the card.
      className={cn(editing && "ring-2 ring-brand/30")}
      action={editable ? <EditToggle label={group} editing={editing} disabled={forced} onEdit={onEdit} onView={onView} /> : undefined}
    >
      {editing ? (
        <div className="space-y-3">{children}</div>
      ) : group === "Pictures" ? (
        pictures.length ? <ImagePreviews label="Pictures" urls={pictures} /> : <p className="text-sm text-slate-400">—</p>
      ) : (
        <dl className="space-y-1.5 text-sm">
          {specs.map((spec) => (
            <div key={spec.name} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3">
              <dt className="text-slate-500">{spec.label}</dt>
              <dd className="min-w-0 break-words font-medium text-slate-900" aria-label={spec.label}>
                {/* The network to join, the one value a technician looks for here: a light pill of the section's hue. */}
                {spec.name === "store_ssid" && valueOf(spec) ? (
                  <span className={cn("inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-0.5", SECTION_TONE.WiFi.value)}>
                    <span className="min-w-0 break-all">{String(valueOf(spec))}</span>
                  </span>
                ) : (
                  <DetailValue spec={spec} value={valueOf(spec)} />
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Section>
  );
}

/** Where each identity field sits on a six-column grid: name and street across, then city / state / ZIP. */
const IDENTITY_SPAN: Record<string, string> = {
  store_name: "sm:col-span-6",
  addr: "sm:col-span-6",
  city: "sm:col-span-2",
  state: "sm:col-span-2",
  zip: "sm:col-span-2",
  dma: "sm:col-span-3",
  venue_type: "sm:col-span-3",
  external_id: "sm:col-span-6",
};

/** The identity values nobody edits here (ExtID, PA, sheet date), as one quiet line above the form. */
function IdentityMeta({ stop, project, specs }: { stop: Stop; project: Project; specs: StoreFieldSpec[] }) {
  const record = stop as unknown as Record<string, unknown>;
  const fixed = specs.filter((spec) => !spec.editable && !(spec.name === "external_id" && !stop.external_id));
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1 border-b border-slate-100 pb-3 text-xs">
      {fixed.map((spec) => {
        const value = spec.name === "pa" ? stop.pa || project.pa : String(record[spec.name] ?? "");
        return (
          <div key={spec.name} className="flex items-baseline gap-1.5">
            <dt className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{spec.label}</dt>
            <dd className="font-semibold text-slate-900" aria-label={spec.label}>
              {value || <span className="font-normal text-slate-400">—</span>}
              {spec.name === "pa" && !stop.pa && project.pa && <span className="ml-1 font-normal text-slate-500">(project)</span>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

const addressOf = (stop: Pick<Stop, "addr" | "city" | "state" | "zip">) => [stop.addr, stop.city, [stop.state, stop.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");

function ReadOnly({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{label}</p>
      <p className="text-sm text-slate-700" aria-label={label}>
        {value || <span className="text-slate-400">—</span>}
        {hint && <span className="ml-1 text-xs text-slate-500">{hint}</span>}
      </p>
    </div>
  );
}

function PasswordInput({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex gap-1">
      <Input id={id} type={shown ? "text" : "password"} autoComplete="off" value={value} onChange={(event) => onChange(event.target.value)} />
      <Button type="button" size="icon" variant="outline" aria-label={shown ? "Hide password" : "Show password"} onClick={() => setShown((now) => !now)}>
        {shown ? <EyeOff /> : <Eye />}
      </Button>
    </div>
  );
}

const CLEAR = "__none__";

function FieldControl({ spec, value, onChange, error }: { spec: StoreFieldSpec; value: FormValue; onChange: (v: FormValue) => void; error?: string }) {
  const id = `store-${spec.name}`;
  if (spec.kind === "tristate") return <TriStateCheckbox id={id} label={spec.label} value={value as boolean | null} onChange={onChange} />;
  if (spec.kind === "bool") {
    return (
      <label className="flex items-center gap-2 text-sm">
        <Checkbox id={id} checked={value === true} onCheckedChange={(checked) => onChange(checked === true)} />
        {spec.label}
      </label>
    );
  }
  const text = typeof value === "string" ? value : "";
  let control;
  if (spec.kind === "select") {
    control = (
      <Select value={text || CLEAR} onValueChange={(next) => onChange(next === CLEAR ? "" : next)}>
        <SelectTrigger id={id} aria-label={spec.label} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={CLEAR}>—</SelectItem>
          {spec.options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else if (spec.kind === "multiline") {
    control = <Textarea id={id} rows={3} value={text} aria-invalid={Boolean(error)} onChange={(event) => onChange(event.target.value)} />;
  } else if (spec.name === "store_ssid_password") {
    control = <PasswordInput id={id} value={text} onChange={onChange} />;
  } else {
    const type = spec.kind === "email" ? "email" : spec.kind === "phone" ? "tel" : "text";
    control = (
      <Input
        id={id}
        type={type}
        inputMode={spec.kind === "int" ? "numeric" : undefined}
        value={text}
        aria-invalid={Boolean(error)}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  const links = spec.kind === "url" ? urlTokens(text) : [];
  return (
    <div className={cn("space-y-1.5", spec.kind === "multiline" || spec.kind === "url" ? "col-span-full" : "")}>
      <Label htmlFor={id}>
        {spec.label}
        {spec.required && " *"}
      </Label>
      {control}
      {links.length > 0 && spec.group === "Pictures" && <ImagePreviews label={spec.label} urls={links} />}
      {links.length > 0 && spec.group !== "Pictures" && (
        <ul className="space-y-0.5 text-xs" aria-label={`${spec.label} links`}>
          {links.map((url) => (
            <li key={url} className="truncate">
              <a href={url} target="_blank" rel="noreferrer" className="text-brand underline-offset-2 hover:underline">
                {url}
              </a>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-xs text-rose-600">{error}</p>}
    </div>
  );
}

function DetailsEditor({
  project,
  stop,
  specs,
  sections,
  technicians,
  aside,
  logs,
}: {
  project: Project;
  stop: Stop;
  specs: StoreFieldSpec[];
  sections: Sections;
  /** Names offered when assigning a technician. */
  technicians: string[];
  /** At the end of the right-hand column. */
  aside: React.ReactNode;
  /** Under the CMS's log entries, in the column's Logs view. */
  logs: React.ReactNode;
}) {
  const [form, setForm] = useState<DetailsForm>(() => detailsFormFrom(stop, specs));
  const [touched, setTouched] = useState(false);
  const [asideView, setAsideView] = useState<"details" | "logs">("details");
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [geoProblem, setGeoProblem] = useState<{ message: string; suggestions: string[] } | null>(null);
  const update = useUpdateStoreDetails(project.id);
  const progress = useUpdateProgress(project.id);
  const screensSave = useUpdateScreens(project.id);
  const validate = useValidateAddress();
  const canEdit = useCan("projects.edit");
  // Everything in the window is one draft, sent by the single Save at the bottom: the store details (counts and
  // install type included), the technician, the manager's notes and the screen rows.
  const [rows, setRows] = useState<ScreenRow[]>(() => toRows(stop));
  const [editingScreens, setEditingScreens] = useState(false);
  // The committed counts in the Screens card: read as numbers until its Edit (like a section), kept in the draft.
  const [editingCommitted, setEditingCommitted] = useState(false);
  const [technician, setTechnician] = useState(stop.installer_name);
  const [comment, setComment] = useState(stop.comment);
  const [reviewNotes, setReviewNotes] = useState(stop.review_notes);
  // The Dolphin data's pin, taken with Overwrite "Map location": saved with the rest (as a picked place, so it is not
  // looked up with Google again).
  const [deviceLocation, setDeviceLocation] = useState(false);
  const errors = { ...(touched ? detailsErrors(form, specs) : {}), ...serverErrors };
  const patch = detailsPatch(stop, form, specs);
  const noTechnician = NO_TECHNICIAN.has(String(form.install_type ?? ""));
  const progressPatch: ProgressUpdate = {};
  const assigned = noTechnician ? "" : technician.trim();
  if (assigned !== stop.installer_name) progressPatch.installer_name = assigned;
  if (comment !== stop.comment) progressPatch.comment = comment;
  if (reviewNotes !== stop.review_notes) progressPatch.review_notes = reviewNotes;
  const rowsDirty = screensChanged(stop, rows);
  const dirty = Object.keys(patch).length > 0 || Object.keys(progressPatch).length > 0 || rowsDirty || deviceLocation;
  /** Fields Overwrite has taken into the draft: the draft holds the Dolphin data's value but the store does not yet. */
  const overwritten: OverwriteField[] = stop.device
    ? (["store_name", "addr", "city", "state", "zip", "dma", "venue_type"] as const).filter(
        (name) => stop.device![name] && form[name] === stop.device![name] && stop[name] !== stop.device![name],
      )
    : [];
  if (deviceLocation) overwritten.push("location");
  /** Overwrite from the Dolphin data: into the draft, like any other edit (Save details writes it). */
  const takeFromDevice = (fields: OverwriteField[]) => {
    const device = stop.device;
    if (!device) return;
    for (const name of fields) {
      if (name === "location") setDeviceLocation(device.lat !== null && device.lng !== null);
      else if (device[name]) set(name, device[name]);
    }
  };
  const saving = update.isPending || progress.isPending || screensSave.isPending;
  const discard = () => {
    setForm(detailsFormFrom(stop, specs));
    setRows(toRows(stop));
    setTechnician(stop.installer_name);
    setComment(stop.comment);
    setReviewNotes(stop.review_notes);
    setDeviceLocation(false);
    setServerErrors({});
    setEditing(new Set());
    setEditingScreens(false);
    setEditingCommitted(false);
  };
  const groupOf = new Map(specs.map((spec) => [spec.name, spec.group]));
  const failing = new Set(Object.keys(errors).map((name) => groupOf.get(name)));
  // Install type is chosen at the top (Installed by), so the Installation panel leaves it out.
  const groupSpecs = (group: Group) => specs.filter((spec) => spec.group === group && spec.name !== "install_type");
  const hint = (group: Group) => {
    const { filled, total } = filledCount(form, groupSpecs(group));
    return !total ? undefined : filled ? `${filled} of ${total} filled` : "empty";
  };

  const set = (name: string, value: FormValue) => {
    setForm((current) => ({ ...current, [name]: value }));
    setServerErrors(({ [name]: _gone, ...rest }) => rest);
  };

  // The address as it was before a suggestion was picked: "Undo" puts it back.
  const [beforePick, setBeforePick] = useState<Pick<DetailsForm, "addr" | "city" | "state" | "zip"> | null>(null);
  const addressLine = ["addr", "city", "state", "zip"].map((key) => String(form[key] ?? "")).filter(Boolean).join(", ");

  // Right-hand sections show their values as line items until their Edit button is pressed.
  const [editing, setEditing] = useState<Set<Group>>(() => new Set());
  const setEditingGroup = (group: Group, on: boolean) =>
    setEditing((current) => {
      const next = new Set(current);
      if (on) next.add(group);
      else next.delete(group);
      return next;
    });

  /** Save the whole draft: screen rows, then technician and progress, then the details (an address change is
   *  geocoded last, so a problem there leaves the rest saved and the address still being edited). */
  const save = async (place?: PlaceHit) => {
    setTouched(true);
    if (Object.keys(detailsErrors(form, specs)).length) return;
    setGeoProblem(null);
    try {
      if (rowsDirty) {
        const saved = await screensSave.mutateAsync({ uid: stop.uid, screens: toInputs(rows) });
        setRows(toRows(saved));
      }
      if (Object.keys(progressPatch).length) await progress.mutateAsync({ uid: stop.uid, body: progressPatch });
      const device = stop.device;
      const picked = place
        ? { lat: place.lat, lng: place.lng, formatted: [place.name, place.formatted].filter(Boolean).join(" · ") }
        : deviceLocation && device && device.lat !== null && device.lng !== null
          ? { lat: device.lat, lng: device.lng, formatted: device.address || addressOf(device) }
          : null;
      if (Object.keys(patch).length || picked) {
        const body = picked ? { ...patch, place: picked } : patch;
        await update.mutateAsync({ uid: stop.uid, body });
      }
      setBeforePick(null);
      setDeviceLocation(false);
      setEditing(new Set());
      setEditingScreens(false);
      setEditingCommitted(false);
      toast.success(addressChanged(patch) ? "Address verified and saved; the route is marked for re-optimising" : "Store saved");
    } catch (error) {
      const detail = error instanceof ApiError ? error.validation : null;
      if (detail?.suggestions !== undefined) setGeoProblem({ message: detail.message, suggestions: detail.suggestions });
      else if (detail?.fields) setServerErrors(detail.fields);
      else toast.error(error instanceof Error ? error.message : "Save failed");
    }
  };

  // A store's address is verified once Google placed it (the sheet's or a person's address, checked on save).
  const verified = Boolean(stop.geocoded) && stop.lat !== null && !stop.needs_attention.includes("address");
  const [verifying, setVerifying] = useState(false);
  /** Check the saved address with Google: a clean match is saved at Google's pin; otherwise the address opens for
   *  editing with Google's suggestions and the search. */
  const verifyAddress = async () => {
    setVerifying(true);
    try {
      const geo = await validate.mutateAsync({ address: addressOf(stop), name: stop.store_name });
      if (geo.ok && !geo.partial && geo.lat !== null && geo.lng !== null) {
        await update.mutateAsync({ uid: stop.uid, body: { place: { lat: geo.lat, lng: geo.lng, formatted: geo.formatted || addressOf(stop) } } });
        toast.success("Address verified");
      } else {
        setEditingGroup("Identity & address", true);
        setGeoProblem({ message: "Google could not verify this address. Pick a suggestion, correct it, or search for the store.", suggestions: geo.suggestions ?? [] });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not check the address");
    } finally {
      setVerifying(false);
    }
  };

  /** A Google suggestion is a full formatted address; resolve it into parts before saving. */
  const applySuggestion = async (suggestion: string) => {
    try {
      const geo = await validate.mutateAsync({ address: suggestion, name: String(form.store_name ?? stop.store_name) });
      if (!geo.ok) return toast.error("That suggestion could not be verified either");
      // Google may know only the road: keep the suggestion's own street line (with its house number) then.
      const addr = geo.partial || !geo.addr ? suggestion.split(",")[0]!.trim() : geo.addr;
      setBeforePick((kept) => kept ?? { addr: form.addr ?? null, city: form.city ?? null, state: form.state ?? null, zip: form.zip ?? null });
      setForm((current) => ({ ...current, addr, city: geo.city || current.city, state: geo.state || current.state, zip: geo.zip || current.zip }));
      setGeoProblem(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not check the suggestion");
    }
  };

  /** A right-hand style section: its values as line items, Edit turns them into controls. */
  const pictureCount = urlTokens(String(form.image_url ?? stop.image_url)).length;
  const detailPanel = (group: Group & SectionName) => (
    <DetailPanel
      key={group}
      group={group}
      stop={stop}
      project={project}
      specs={groupSpecs(group)}
      sections={sections}
      summary={group === "Pictures" ? (pictureCount ? `${pictureCount} ${pictureCount === 1 ? "picture" : "pictures"}` : "empty") : hint(group)}
      editing={editing.has(group) || failing.has(group)}
      forced={failing.has(group)}
      values={form}
      onEdit={() => {
        sections.open(group);
        setEditingGroup(group, true);
      }}
      onView={() => setEditingGroup(group, false)}
    >
      <div className={cn("grid gap-3", group === "Site checklist" || group === "Pictures" ? "" : "sm:grid-cols-2")}>
        {groupSpecs(group).map(control)}
      </div>
    </DetailPanel>
  );

  const control = (spec: StoreFieldSpec) =>
    spec.name === "external_id" && !stop.external_id ? (
      <ExternalIdInput key={spec.name} projectId={project.id} uid={stop.uid} />
    ) : spec.editable ? (
      <FieldControl key={spec.name} spec={spec} value={form[spec.name] ?? null} onChange={(value) => set(spec.name, value)} error={errors[spec.name]} />
    ) : (
      <ReadOnly
        key={spec.name}
        label={spec.label}
        value={spec.name === "pa" ? stop.pa || project.pa : String((stop as unknown as Record<string, unknown>)[spec.name] ?? "")}
        hint={spec.name === "pa" && !stop.pa && project.pa ? "(project)" : undefined}
      />
    );

  const identityEditing =
    editing.has("Identity & address") || failing.has("Identity & address") || geoProblem !== null || beforePick !== null;
  const groupSection = (group: Group & SectionName) => (
    <Section
      key={group}
      title={group}
      sections={sections}
      summary={hint(group)}
      forceOpen={failing.has(group) || (group === "Identity & address" && geoProblem !== null)}
      action={
        <EditToggle
          label={group}
          editing={identityEditing}
          // An invalid value, or an address Google is still being asked about, keeps the form open.
          disabled={failing.has(group) || geoProblem !== null}
          onEdit={() => {
            sections.open(group);
            setEditingGroup(group, true);
          }}
          onView={() => {
            setEditingGroup(group, false);
            setBeforePick(null);
          }}
        />
      }
    >
      {group === "Identity & address" && !identityEditing ? (
        <>
          <IdentityMeta stop={stop} project={project} specs={groupSpecs(group)} />
          {!stop.external_id && <ExternalIdInput projectId={project.id} uid={stop.uid} />}
          <dl className="space-y-1.5 text-sm">
            {/* The draft, so an edit stays visible here until it is saved or discarded. */}
            {[
              ["Store name", String(form.store_name ?? "")],
              ["Address", addressOf({ addr: String(form.addr ?? ""), city: String(form.city ?? ""), state: String(form.state ?? ""), zip: String(form.zip ?? "") })],
              ["DMA", String(form.dma ?? "")],
              ["Venue type", String(form.venue_type ?? "")],
            ].map(([label, value]) => (
              <div key={label} className="grid grid-cols-[minmax(0,1fr)_minmax(0,3fr)] gap-3">
                <dt className="text-slate-500">{label}</dt>
                <dd className="min-w-0 break-words font-medium text-slate-900" aria-label={label}>
                  {value || <span className="font-normal text-slate-400">—</span>}
                </dd>
              </div>
            ))}
          </dl>
        </>
      ) : group === "Identity & address" ? (
        <>
          <IdentityMeta stop={stop} project={project} specs={groupSpecs(group)} />
          <div className="grid gap-3 sm:grid-cols-6">
            {groupSpecs(group)
              .filter((spec) => spec.editable || (spec.name === "external_id" && !stop.external_id))
              .map((spec) => (
                <div key={spec.name} className={IDENTITY_SPAN[spec.name] ?? "sm:col-span-3"}>
                  {control(spec)}
                </div>
              ))}
          </div>
        </>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{groupSpecs(group).map(control)}</div>
      )}
      {group === "Identity & address" && (
        <>
          {/* The address's standing, in words and an icon as well as its colour: green once Google placed it, amber
              while it is not verified. */}
          {verified ? (
            <p role="note" aria-label="Address verified" className="flex items-start gap-1.5 rounded-md border border-green-200 bg-green-50 px-2 py-1.5 text-xs text-green-900">
              <BadgeCheck size={14} aria-hidden className="mt-px shrink-0 text-green-700" />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <span className="font-semibold">Verified</span> as {stop.geocoded}
              </span>
            </p>
          ) : (
            <div role="note" aria-label="Address not verified" className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
              <AlertTriangle size={14} aria-hidden className="shrink-0 text-amber-700" /> This address is not verified with Google, so the map pin may be off.
              <Button size="xs" variant="outline" className="ml-auto" disabled={verifying} onClick={() => void verifyAddress()}>
                {verifying ? <Loader2 className="animate-spin" /> : <MapPin />} Verify address
              </Button>
            </div>
          )}
          {/* Only a store in a route plan has a route the move can upset. */}
          {stop.route_stale && stop.route_plan_id && (
            <p className="flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
              <AlertTriangle size={12} /> The address changed after this store was put in its route plan; re-optimise the plan.
            </p>
          )}
          {beforePick && (
            <p className="flex items-center gap-2 text-xs text-slate-600">
              Address taken from Google's suggestion.
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  setForm((current) => ({ ...current, ...beforePick }));
                  setBeforePick(null);
                }}
              >
                <Undo2 /> Undo
              </Button>
            </p>
          )}
          {geoProblem && (
            <div role="alert" className="space-y-2 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
              <p>{geoProblem.message}</p>
              {geoProblem.suggestions.length > 0 && (
                <ul className="space-y-1">
                  {geoProblem.suggestions.map((suggestion) => (
                    <li key={suggestion}>
                      <button type="button" className="text-left text-brand underline-offset-2 hover:underline" onClick={() => applySuggestion(suggestion)}>
                        {suggestion}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap items-center gap-2 border-t border-rose-200 pt-2 text-xs">
                <span>Not right?</span>
                <GoogleSearchPicker address={addressLine} name={String(form.store_name ?? stop.store_name)} onPick={(hit) => void save(hit)} />
              </div>
            </div>
          )}
        </>
      )}
    </Section>
  );

  return (
    <div className="space-y-4 pt-5">
      <StoreSummary
        draft={{
          counts: Object.fromEntries(COUNT_KEYS.map((key) => [key, String(form[key] ?? "")])) as SummaryDraft["counts"],
          errors: Object.fromEntries(COUNT_KEYS.filter((key) => errors[key]).map((key) => [key, errors[key]])),
          rows,
          technician,
          installType: String(form.install_type ?? ""),
        }}
        technicians={technicians}
        costs={project.hardware_costs}
        editingCommitted={editingCommitted}
        onEditCommitted={setEditingCommitted}
        onCount={set}
        onTechnician={setTechnician}
        // Technician is the default: a store saved without a type keeps "" (it reads as Technician once named).
        onInstallType={(type) => set("install_type", type === "Technician" && !stop.install_type ? "" : type)}
      />
      {/* Done with fewer screen rows than committed: Ignore mismatch / Undo (saved at once). */}
      <MismatchNotice project={project} stop={stop} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 space-y-3" aria-label="Edit">
          {groupSection("Identity & address")}
          <Section
            title="Screens"
            sections={sections}
            summary={`${rows.length} screen${rows.length === 1 ? "" : "s"}`}
            action={
              <EditToggle
                label="Screens"
                editing={editingScreens}
                onEdit={() => {
                  sections.open("Screens");
                  setEditingScreens(true);
                }}
                onView={() => setEditingScreens(false)}
              />
            }
          >
            {editingScreens ? (
              <ScreensEditor project={project} stop={stop} rows={rows} onChange={setRows} />
            ) : (
              <ScreensView project={project} stop={stop} rows={rows} />
            )}
          </Section>
          {/* The project manager's own notes (stored as the store's `comment`). Installation and site notes come
              from the sheet and the people on site, and sit under Other details. */}
          <Section
            title="Notes"
            sections={sections}
            summary={reviewNotes.trim() ? "Review notes to check" : comment.trim() ? undefined : "empty"}
          >
            <Textarea
              aria-label="Manager notes"
              title="For whoever manages the project. Installation and site notes are under Other details."
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              rows={4}
              placeholder="Your notes on this store: follow-ups, decisions, anything to remember"
            />
            {/* What the import's review left to check; cleared here once it is settled (the Review notes filter
                lists the stores that still have some). */}
            <div className="space-y-1.5">
              <Label
                htmlFor="store-review-notes"
                title="From the import's review step. Clear them once checked."
                className={cn("flex items-center gap-1", reviewNotes.trim() && "text-amber-800")}
              >
                {reviewNotes.trim() && <AlertTriangle size={12} />} Review notes
              </Label>
              <Textarea
                id="store-review-notes"
                value={reviewNotes}
                onChange={(event) => setReviewNotes(event.target.value)}
                rows={2}
                maxLength={2000}
                placeholder="What still needs checking, e.g. store name not confirmed"
                className={cn(reviewNotes.trim() && "border-amber-300 bg-amber-50/50")}
              />
            </div>
          </Section>
          {/* Pictures, with the store on a small map under them: last, below the notes. */}
          {detailPanel("Pictures")}
          <LocationSection stop={stop} sections={sections} />
        </div>
        <aside
          className="min-w-0 space-y-3 lg:sticky lg:top-4 lg:-m-1 lg:max-h-[calc(94vh-12rem)] lg:self-start lg:overflow-y-auto lg:p-1"
          aria-label="Store details"
        >
          {/* The column shows the store's other details, or the CMS's servicing logs for its DD codes. */}
          <div role="tablist" aria-label="Right column" className="inline-flex rounded-xl bg-white/60 p-1 text-sm font-medium shadow-sm ring-1 ring-slate-900/5">
            {(["details", "logs"] as const).map((view) => (
              <button
                key={view}
                type="button"
                role="tab"
                aria-selected={asideView === view}
                onClick={() => setAsideView(view)}
                className={cn("h-8 rounded-lg px-4 transition-colors motion-reduce:transition-none", asideView === view ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-900/5" : "text-slate-600 hover:text-slate-900")}
              >
                {view === "details" ? "Other details" : "Logs"}
              </button>
            ))}
          </div>
          {/* Hidden, not unmounted, while the logs show: a section being edited keeps its place. */}
          <div hidden={asideView !== "details"} className="space-y-3">
            {ASIDE_GROUPS.flatMap((group) => {
              const panel = detailPanel(group);
              // The Dolphin data's values sit right after WiFi, as before; shown (open) only while something differs.
              return group === "WiFi"
                ? [panel, <div key="device" className="empty:hidden"><StoreDeviceSection project={project} stop={stop} pending={overwritten} onOverwrite={takeFromDevice} /></div>]
                : [panel];
            })}
            {aside}
          </div>
          {asideView === "logs" && (
            <>
              <StoreLogs projectId={project.id} stopUid={stop.uid} />
              {logs}
            </>
          )}
        </aside>
      </div>
      <div hidden={!canEdit} className="glass-bar sticky bottom-0 -mx-6 mt-3 flex justify-end gap-2 border-t border-(--glass-bar-line) px-6 py-3 shadow-[0_-8px_24px_-12px_rgb(15_23_42/0.18)]">
        {dirty && <span className="mr-auto self-center text-xs text-amber-700">Unsaved changes</span>}
        <Button variant="ghost" disabled={!dirty || saving} onClick={discard}>
          Discard
        </Button>
        <Button onClick={() => void save()} disabled={!dirty || saving}>
          {saving && <Loader2 className="animate-spin" />} {addressChanged(patch) ? "Verify address and save" : "Save details"}
        </Button>
      </div>
    </div>
  );
}

/** The store on a small map. The section is open like the others, but the Google map (a billed map load) is drawn
 *  only once the section is opened and scrolls into view, so opening a store to read its notes loads no map. */
function LocationSection({ stop, sections }: { stop: Stop; sections: Sections }) {
  const at = shownLocation(stop);
  const place = [stop.city, stop.state].filter(Boolean).join(", ");
  return (
    <Section
      title="Location"
      sections={sections}
      lazy
      summary={at ? place || "On the map" : "No map location"}
      action={
        at && (
          <a
            href={`https://www.google.com/maps/search/?api=1&query=${at.lat},${at.lng}`}
            target="_blank"
            rel="noreferrer"
            className="relative shrink-0 text-xs text-brand after:absolute after:-inset-x-1 after:-inset-y-3 hover:underline"
          >
            Open in Google Maps
          </a>
        )
      }
    >
      <WhenVisible placeholder={<div className="h-64 rounded-lg bg-emerald-50/50" aria-hidden />}>
        <StoreLocationMap stop={stop} bare />
      </WhenVisible>
    </Section>
  );
}

/** Columns the import did not recognise (`fields`), read only (STORE-MODEL §3.8), as line items. */
function OtherData({ project, stop, sections }: { project: Project; stop: Stop; sections: Sections }) {
  const labels = new Map(project.field_schema.map((field) => [field.key, field.label]));
  const entries = Object.entries(stop.fields).filter(([, value]) => value !== null && value !== undefined && value !== "");
  return (
    <Section
      title="Other imported data"
      sections={sections}
      summary={entries.length ? `${entries.length} ${entries.length === 1 ? "value" : "values"}` : "empty"}
    >
      {entries.length === 0 ? (
        <p className="text-sm text-slate-400" title="Nothing else came with this store">—</p>
      ) : (
        <dl className="space-y-1.5 text-sm">
          {entries.map(([key, value]) => (
            <div key={key} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3">
              <dt className="text-slate-500">{labels.get(key) ?? key.replace(/_/g, " ")}</dt>
              <dd className="whitespace-pre-wrap break-words font-medium text-slate-900">{String(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </Section>
  );
}

/** A store added from the Dolphin data has no ExtID: enter it once here (it is fixed after that, like any ExtID). */
function ExternalIdInput({ projectId, uid }: { projectId: string; uid: string }) {
  const [value, setValue] = useState("");
  const save = useSetExternalId(projectId);
  const canEdit = useCan("projects.edit");
  if (!canEdit) return <p className="text-xs text-amber-800">ExtID missing</p>;
  return (
    <div className="space-y-1.5">
      <Label htmlFor="store-external_id" className="flex items-center gap-1 text-amber-800">
        <AlertTriangle size={12} /> ExtID (missing)
      </Label>
      <form
        className="flex gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(
            { uid, externalId: value.trim() },
            {
              onSuccess: (stop) => toast.success(`ExtID ${stop.external_id} saved`),
              onError: (error) => toast.error(error instanceof Error ? error.message : "Could not save the ExtID"),
            },
          );
        }}
      >
        <Input id="store-external_id" value={value} placeholder="e.g. FL18993" onChange={(event) => setValue(event.target.value.toUpperCase())} aria-invalid />
        <Button type="submit" variant="outline" disabled={!value.trim() || save.isPending}>
          {save.isPending && <Loader2 className="animate-spin" />} Save
        </Button>
      </form>
      <p className="text-xs text-slate-600" title="The Dolphin data has no ExtID for this store.">It cannot be changed once saved.</p>
    </div>
  );
}
