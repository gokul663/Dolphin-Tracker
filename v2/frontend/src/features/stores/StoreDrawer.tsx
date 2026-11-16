import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useRoutePlans } from "@/features/planner/api";
import { VisitHistory, VisitPanel } from "@/features/visits/VisitPanel";
import { AlertTriangle, CheckCircle2, CircleSlash, ChevronLeft, ChevronRight, ExternalLink, X, Pencil, ClipboardCheck, ChevronsDownUp, ChevronsUpDown, Eye, EyeOff, ImageOff, Loader2, MapPin, Undo2, Wifi } from "lucide-react";
import { toast } from "sonner";
import { TriStateCheckbox } from "@/components/TriStateCheckbox";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useStoreFields, useValidateAddress } from "@/features/places/api";
import { GoogleSearchPicker } from "@/features/places/GoogleSearchPicker";
import type { PlaceHit } from "@/lib/api/types";
import { screensChanged, ScreensEditor, ScreensView, toInputs, toRows, type ScreenRow } from "@/features/stores/ScreensEditor";
import { deviceDifferences, StoreDeviceSection } from "@/features/device/StoreDeviceSection";
import { reportDay, splitCodes } from "@/features/device/DeviceBits";
import { StoreLocationMap } from "@/components/map/StoreLocationMap";
import { COUNT_KEYS, NO_TECHNICIAN, StoreSummary, type SummaryDraft } from "@/features/stores/StoreSummary";
import { useFilterOptions, useSetExternalId, useStore, useUpdateProgress, useUpdateScreens, useUpdateStoreDetails } from "@/features/stores/api";
import {
  addressChanged,
  detailsErrors,
  detailsFormFrom,
  detailsPatch,
  filledCount,
  previewSrc,
  type DetailsForm,
  type FormValue,
} from "@/features/stores/details";
import { ApiError, type OverwriteField, type ProgressUpdate, type Project, type Stop, type StoreFieldSpec } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";
import { cn } from "@/lib/utils";
import { urlTokens } from "@/lib/validation/storeFields";

interface Props {
  project: Project;
  stopId: string | null;
  open: boolean;
  onClose: () => void;
}

type Group = StoreFieldSpec["group"];
/** The collapsible sections on the left; the right-hand details are always shown as line items. */
const SECTIONS = ["Identity & address", "Screens", "Progress"] as const;
type SectionName = (typeof SECTIONS)[number];
const DEFAULT_OPEN: SectionName[] = ["Identity & address", "Screens"];
/** The right-hand column: reference material, still editable but out of the way of address and screens. */
const ASIDE_GROUPS: Group[] = ["WiFi", "Contacts", "Installation", "Site notes", "Site checklist"];

interface Sections {
  isOpen: (name: SectionName) => boolean;
  toggle: (name: SectionName) => void;
}

/** Full editor for one store in a large modal, in two columns like the visit log: on the left what gets edited on
 *  site (address, then the screens right under it, then progress); on the right the
 *  reference material (pictures, WiFi, Dolphin data, contacts, installation, site notes and checklist, other
 *  imported data, servicing history). Every section stays collapsible and editable. */
export function StoreDrawer({ project, stopId, open, onClose }: Props) {
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
  };
  const allOpen = expanded.size === SECTIONS.length;
  const [logging, setLogging] = useState(false);
  const plans = useRoutePlans("active");
  // Everyone already assigned somewhere in the project, offered when assigning this store.
  const options = useFilterOptions(project.id, {});
  const technicians = (options.data?.technician ?? []).map((option) => option.value).filter(Boolean);
  const planNames = new Map((plans.data ?? []).map((plan) => [plan.id, plan.name]));
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[94vh] w-[90vw] max-w-[90vw] flex-col gap-0 p-0 sm:max-w-[90vw]">
        <DialogHeader className="border-b px-6 pt-5 pb-3 pr-12">
          <DialogTitle className="font-mono uppercase tracking-wider text-brand">
            {stop ? `${stop.external_id || stop.display_id} · ${stop.store_name}` : "Store"}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap items-center gap-2">
              {stop && (
                <span className={cn("rounded border px-1.5 py-0.5 text-xs font-medium", STATUS_META[stop.status].chip)}>
                  {STATUS_META[stop.status].label}
                </span>
              )}
              {stop && <StoreAlerts project={project} stop={stop} />}
              {stop?.route_plan_id ? (
                <Link to={`/planner/${stop.route_plan_id}`} className="rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-800 hover:underline">
                  In route: {planNames.get(stop.route_plan_id) ?? "open the plan"}
                </Link>
              ) : (
                <span>Not in a route</span>
              )}
              {stop && (
                <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => setLogging(true)}>
                  <ClipboardCheck /> Log visit
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto h-7 text-xs"
                onClick={() => setExpanded(new Set(allOpen ? [] : SECTIONS))}
              >
                {allOpen ? <ChevronsDownUp /> : <ChevronsUpDown />} {allOpen ? "Collapse all" : "Expand all"}
              </Button>
            </div>
          </DialogDescription>
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
              aside={
                <>
                  <OtherData project={project} stop={stop} />
                  <section aria-label="Servicing history" className="rounded-lg border p-3">
                    <h3 className="mb-2 font-mono text-[11px] uppercase tracking-wider text-slate-600">Servicing history</h3>
                    <VisitHistory projectId={project.id} stop={stop} bare />
                  </section>
                </>
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
    </Dialog>
  );
}

/** The store's standing at a glance, beside its name: whether it matches the Dolphin data, and anything that needs
 *  fixing (an unverified address, a DD code entry holding several codes, no IBC# or name). */
function StoreAlerts({ project, stop }: { project: Project; stop: Stop }) {
  const day = project.device_sync?.snapshot_date ?? stop.device?.date ?? "";
  const missing = stop.needs_attention.includes("not_reporting");
  const differs = deviceDifferences(stop).length;
  const verified = Boolean(stop.geocoded) && stop.lat !== null && !stop.needs_attention.includes("address");
  const clubbed = stop.screens.filter((screen) => splitCodes(screen.venue_id).length > 1).length;
  const pill = (tone: string, text: string, icon: React.ReactNode, title?: string) => (
    <span key={text} className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", tone)} title={title}>
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
    <span className="flex flex-wrap items-center gap-1.5" aria-label="Store alerts">
      {sync}
      {!verified && pill(warn, "Address not verified", <MapPin size={12} />)}
      {clubbed > 0 && pill(warn, clubbed === 1 ? "DD code holds several codes" : `${clubbed} DD codes hold several codes`, <AlertTriangle size={12} />, "Split them under Screens so each matches its device")}
      {!stop.external_id && pill(warn, "No IBC#", <AlertTriangle size={12} />)}
      {stop.needs_attention.includes("store_name") && pill(warn, "No store name", <AlertTriangle size={12} />)}
    </span>
  );
}

/** A collapsible section. Closed content stays mounted (hidden), so unsaved edits inside it survive a collapse;
 *  `forceOpen` keeps a section with a validation problem visible. */
function Section({
  title,
  sections,
  hint,
  forceOpen = false,
  icon,
  className,
  action,
  children,
}: {
  title: SectionName;
  sections: Sections;
  hint?: string;
  forceOpen?: boolean;
  icon?: React.ReactNode;
  className?: string;
  /** A button beside the title (Edit / View). */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const open = forceOpen || sections.isOpen(title);
  const bodyId = `store-section-${title.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <section className={cn("rounded-lg border", className)} aria-label={title}>
      <div className="flex items-center gap-2 pr-3">
        <h3 className="min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => sections.toggle(title)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-[11px] uppercase tracking-wider text-slate-600 hover:bg-slate-50"
          >
            <ChevronRight size={14} className={cn("transition-transform", open && "rotate-90")} />
            {icon}
            <span>{title}</span>
            {hint && <span className="ml-auto font-sans text-xs normal-case tracking-normal text-slate-400">{hint}</span>}
          </button>
        </h3>
        {action}
      </div>
      <div id={bodyId} hidden={!open} className="space-y-3 border-t p-3">
        {children}
      </div>
    </section>
  );
}

/** A value as a line item: Yes/No for checks, links for URLs, dots for the WiFi password (with a reveal). */
function DetailValue({ spec, value }: { spec: StoreFieldSpec; value: unknown }) {
  const [shown, setShown] = useState(false);
  if (value === null || value === undefined || value === "") return <span className="text-slate-300">—</span>;
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

/** One section in the visit log's style: every field as a label / value line; Edit turns it into its form and View
 *  back into lines. Both show the draft (the window's Save sends it, Discard drops it), so View never loses an edit. */
function DetailPanel({
  group,
  stop,
  project,
  specs,
  editing,
  forced = false,
  values,
  onEdit,
  onView,
  children,
}: {
  group: Group;
  stop: Stop;
  project: Project;
  specs: StoreFieldSpec[];
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
    <section aria-label={group} className={cn("rounded-lg border p-3", group === "WiFi" && "border-sky-200 bg-sky-50/40", editing && "border-brand/40 ring-1 ring-brand/20")}>
      <div className="mb-2 flex items-center gap-2">
        {group === "WiFi" && <Wifi size={13} className="text-slate-500" />}
        <h3 className="font-mono text-[11px] uppercase tracking-wider text-slate-600">{group}</h3>
        {editable && (
          <span className="ml-auto">
            <EditToggle label={group} editing={editing} disabled={forced} onEdit={onEdit} onView={onView} />
          </span>
        )}
      </div>
      {editing ? (
        <div className="space-y-3">{children}</div>
      ) : group === "Pictures" ? (
        pictures.length ? <ImagePreviews label="Pictures" urls={pictures} /> : <p className="text-sm text-slate-400">No pictures yet.</p>
      ) : (
        <dl className="space-y-1.5 text-sm">
          {specs.map((spec) => (
            <div key={spec.name} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3">
              <dt className="text-slate-500">{spec.label}</dt>
              <dd className="min-w-0 break-words text-slate-800" aria-label={spec.label}>
                <DetailValue spec={spec} value={valueOf(spec)} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
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

/** The identity values nobody edits here (IBC#, PA, sheet date), as one quiet line above the form. */
function IdentityMeta({ stop, project, specs }: { stop: Stop; project: Project; specs: StoreFieldSpec[] }) {
  const record = stop as unknown as Record<string, unknown>;
  const fixed = specs.filter((spec) => !spec.editable && !(spec.name === "external_id" && !stop.external_id));
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1 rounded-md bg-slate-50 px-3 py-2 text-xs">
      {fixed.map((spec) => {
        const value = spec.name === "pa" ? stop.pa || project.pa : String(record[spec.name] ?? "");
        return (
          <div key={spec.name} className="flex items-baseline gap-1.5">
            <dt className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{spec.label}</dt>
            <dd className="font-medium text-slate-800" aria-label={spec.label}>
              {value || <span className="text-slate-300">—</span>}
              {spec.name === "pa" && !stop.pa && project.pa && <span className="ml-1 font-normal text-slate-400">(project)</span>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** Edit, then View to see the section as text again. Neither saves nor drops anything: the window's Save and
 *  Discard do that for every section at once. */
function EditToggle({ label, editing, disabled = false, onEdit, onView }: { label: string; editing: boolean; disabled?: boolean; onEdit: () => void; onView: () => void }) {
  return editing ? (
    <Button type="button" size="xs" variant="outline" aria-label={`View ${label}`} disabled={disabled} title={disabled ? "Fix the highlighted value first" : "Back to the text view; the changes stay until you save or discard"} onClick={onView}>
      <Eye /> View
    </Button>
  ) : (
    <Button type="button" size="xs" variant="outline" aria-label={`Edit ${label}`} onClick={onEdit}>
      <Pencil /> Edit
    </Button>
  );
}

const addressOf = (stop: Pick<Stop, "addr" | "city" | "state" | "zip">) => [stop.addr, stop.city, [stop.state, stop.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");

function ReadOnly({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{label}</p>
      <p className="text-sm text-slate-700" aria-label={label}>
        {value || <span className="text-slate-300">—</span>}
        {hint && <span className="ml-1 text-xs text-slate-400">{hint}</span>}
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
}: {
  project: Project;
  stop: Stop;
  specs: StoreFieldSpec[];
  sections: Sections;
  /** Names offered when assigning a technician. */
  technicians: string[];
  /** At the end of the right-hand column. */
  aside: React.ReactNode;
}) {
  const [form, setForm] = useState<DetailsForm>(() => detailsFormFrom(stop, specs));
  const [touched, setTouched] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [geoProblem, setGeoProblem] = useState<{ message: string; suggestions: string[] } | null>(null);
  const update = useUpdateStoreDetails(project.id);
  const progress = useUpdateProgress(project.id);
  const screensSave = useUpdateScreens(project.id);
  const validate = useValidateAddress();
  // Everything in the window is one draft, sent by the single Save at the bottom: the store details (counts and
  // install type included), the technician, the progress note and the screen rows.
  const [rows, setRows] = useState<ScreenRow[]>(() => toRows(stop));
  const [editingScreens, setEditingScreens] = useState(false);
  const [technician, setTechnician] = useState(stop.installer_name);
  const [comment, setComment] = useState(stop.comment);
  const [additionalTask, setAdditionalTask] = useState(stop.additional_task);
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
  if (additionalTask !== stop.additional_task) progressPatch.additional_task = additionalTask;
  const rowsDirty = screensChanged(stop, rows);
  const dirty = Object.keys(patch).length > 0 || Object.keys(progressPatch).length > 0 || rowsDirty || deviceLocation;
  /** Fields Overwrite has taken into the draft: the draft holds the Dolphin data's value but the store does not yet. */
  const overwritten: OverwriteField[] = stop.device
    ? (["store_name", "addr", "city", "state", "zip"] as const).filter(
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
    setAdditionalTask(stop.additional_task);
    setDeviceLocation(false);
    setServerErrors({});
    setEditing(new Set());
    setEditingScreens(false);
  };
  const groupOf = new Map(specs.map((spec) => [spec.name, spec.group]));
  const failing = new Set(Object.keys(errors).map((name) => groupOf.get(name)));
  // Install type is chosen at the top (Installed by), so the Installation panel leaves it out.
  const groupSpecs = (group: Group) => specs.filter((spec) => spec.group === group && spec.name !== "install_type");
  const hint = (group: Group) => {
    const { filled, total } = filledCount(form, groupSpecs(group));
    return total ? `${filled} of ${total} filled` : undefined;
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
  const detailPanel = (group: Group) => (
    <DetailPanel
      key={group}
      group={group}
      stop={stop}
      project={project}
      specs={groupSpecs(group)}
      editing={editing.has(group) || failing.has(group)}
      forced={failing.has(group)}
      values={form}
      onEdit={() => setEditingGroup(group, true)}
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
      hint={hint(group)}
      forceOpen={failing.has(group) || (group === "Identity & address" && geoProblem !== null)}
      action={
        <EditToggle
          label={group}
          editing={identityEditing}
          // An invalid value, or an address Google is still being asked about, keeps the form open.
          disabled={failing.has(group) || geoProblem !== null}
          onEdit={() => setEditingGroup(group, true)}
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
                <dd className="min-w-0 break-words text-slate-800" aria-label={label}>
                  {value || <span className="text-slate-300">—</span>}
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
          {verified ? (
            <p className="flex items-center gap-1 text-xs text-slate-500">
              <MapPin size={12} /> Verified as {stop.geocoded}
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
              <AlertTriangle size={12} /> This address is not verified with Google, so the map pin may be off.
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
    <div className="space-y-4 pt-4">
      <StoreSummary
        draft={{
          counts: Object.fromEntries(COUNT_KEYS.map((key) => [key, String(form[key] ?? "")])) as SummaryDraft["counts"],
          errors: Object.fromEntries(COUNT_KEYS.filter((key) => errors[key]).map((key) => [key, errors[key]])),
          rows,
          technician,
          installType: String(form.install_type ?? ""),
        }}
        technicians={technicians}
        onCount={set}
        onTechnician={setTechnician}
        // Technician is the default: a store saved without a type keeps "" (it reads as Technician once named).
        onInstallType={(type) => set("install_type", type === "Technician" && !stop.install_type ? "" : type)}
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 space-y-3" aria-label="Edit">
          {groupSection("Identity & address")}
          <Section
            title="Screens"
            sections={sections}
            hint={`${rows.length} screen${rows.length === 1 ? "" : "s"}`}
            action={
              <EditToggle label="Screens" editing={editingScreens} onEdit={() => setEditingScreens(true)} onView={() => setEditingScreens(false)} />
            }
          >
            {editingScreens ? (
              <ScreensEditor project={project} stop={stop} rows={rows} onChange={setRows} />
            ) : (
              <ScreensView project={project} stop={stop} rows={rows} />
            )}
          </Section>
          {/* Pictures on the left, with the store on a small map under them. */}
          {detailPanel("Pictures")}
          <StoreLocationMap stop={stop} />
          <Section title="Progress" sections={sections}>
            <div className="flex items-center gap-2">
              <Checkbox id="additional-task" checked={additionalTask} onCheckedChange={(checked) => setAdditionalTask(checked === true)} />
              <Label htmlFor="additional-task">Additional task done</Label>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="comment">Comment</Label>
              <Textarea id="comment" value={comment} onChange={(event) => setComment(event.target.value)} rows={3} />
            </div>
          </Section>
        </div>
        <aside
          className="min-w-0 space-y-3 lg:sticky lg:top-4 lg:max-h-[calc(94vh-12rem)] lg:self-start lg:overflow-y-auto lg:border-l lg:pl-4"
          aria-label="Store details"
        >
          <p className="font-mono text-[10px] uppercase tracking-[2px] text-slate-500">Other details</p>
          {ASIDE_GROUPS.flatMap((group) => {
            const panel = detailPanel(group);
            // The Dolphin data's values sit right after WiFi, as before.
            return group === "WiFi" ? [panel, <StoreDeviceSection key="device" project={project} stop={stop} pending={overwritten} onOverwrite={takeFromDevice} />] : [panel];
          })}
          {aside}
        </aside>
      </div>
      <div className="sticky bottom-0 -mx-6 mt-3 flex justify-end gap-2 border-t bg-white px-6 py-3">
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

/** Previews of the picture links, shown a moment after typing stops. A link that is not an image (or not
 *  reachable) falls back to a plain link. */
function ImagePreviews({ label, urls }: { label: string; urls: string[] }) {
  const key = urls.join(" ");
  const [shown, setShown] = useState(urls);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(urls), 400);
    return () => window.clearTimeout(timer);
  }, [key]); // the list is rebuilt on every render; its text is what changes
  return (
    <>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label={`${label} links`}>
        {shown.map((url, index) => (
          <li key={url}>
            <ImagePreview url={url} onOpen={() => setOpen(index)} />
          </li>
        ))}
      </ul>
      {open !== null && shown[open] && <Lightbox urls={shown} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </>
  );
}

function ImagePreview({ url, onOpen }: { url: string; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="overflow-hidden rounded-md border bg-slate-50 hover:border-brand">
      {failed ? (
        <a href={url} target="_blank" rel="noreferrer" className="flex h-40 flex-col items-center justify-center gap-1 p-3 text-center text-xs text-slate-500">
          <ImageOff size={18} /> No preview for this link. Open it
        </a>
      ) : (
        <button type="button" className="block w-full cursor-zoom-in" aria-label="Show picture full size" onClick={onOpen}>
          <img
            src={previewSrc(url)}
            alt="Store picture"
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
            className="h-48 w-full object-cover"
          />
        </button>
      )}
      <a href={url} target="_blank" rel="noreferrer" className="block truncate border-t px-2 py-1 text-xs text-brand hover:underline">
        {url}
      </a>
    </div>
  );
}

/** A picture filling the store window (not a new tab): Esc or × closes it, arrows step through several. The store
 *  window's transform makes `fixed` cover the window itself rather than the whole screen. */
function Lightbox({ urls, index, onIndex, onClose }: { urls: string[]; index: number; onIndex: (index: number) => void; onClose: () => void }) {
  const many = urls.length > 1;
  const step = (by: number) => onIndex((index + by + urls.length) % urls.length);
  useEffect(() => {
    // Capture on window, ahead of the dialog's own Esc handler, so Esc closes the picture and not the store.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (many && event.key === "ArrowRight") step(1);
      else if (many && event.key === "ArrowLeft") step(-1);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  const url = urls[index]!;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Store picture"
      className="fixed inset-0 z-50 flex flex-col bg-slate-950/95 sm:rounded-lg"
      onClick={onClose}
    >
      <div className="flex items-center gap-2 px-4 py-3 text-sm text-white/80" onClick={(event) => event.stopPropagation()}>
        {many && (
          <span className="font-mono text-xs">
            {index + 1} / {urls.length}
          </span>
        )}
        <a href={url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs hover:text-white">
          <ExternalLink size={13} /> Open original
        </a>
        <Button type="button" size="icon" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" aria-label="Close picture" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-12 pb-6">
        <img
          src={previewSrc(url)}
          alt="Store picture, full size"
          referrerPolicy="no-referrer"
          className="max-h-full max-w-full object-contain"
          onClick={(event) => event.stopPropagation()}
        />
        {many && (
          <>
            <Button type="button" size="icon" variant="ghost" className="absolute left-2 text-white hover:bg-white/10 hover:text-white" aria-label="Previous picture" onClick={(event) => { event.stopPropagation(); step(-1); }}>
              <ChevronLeft />
            </Button>
            <Button type="button" size="icon" variant="ghost" className="absolute right-2 text-white hover:bg-white/10 hover:text-white" aria-label="Next picture" onClick={(event) => { event.stopPropagation(); step(1); }}>
              <ChevronRight />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** Columns the import did not recognise (`fields`), read only (STORE-MODEL §3.8), as line items. */
function OtherData({ project, stop }: { project: Project; stop: Stop }) {
  const labels = new Map(project.field_schema.map((field) => [field.key, field.label]));
  const entries = Object.entries(stop.fields).filter(([, value]) => value !== null && value !== undefined && value !== "");
  return (
    <section aria-label="Other imported data" className="rounded-lg border p-3">
      <h3 className="mb-2 flex items-center font-mono text-[11px] uppercase tracking-wider text-slate-600">
        Other imported data
        {entries.length > 0 && <span className="ml-auto font-sans text-xs normal-case tracking-normal text-slate-400">{entries.length} values</span>}
      </h3>
      {entries.length === 0 ? (
        <p className="text-sm text-slate-400">Nothing else came with this store.</p>
      ) : (
        <dl className="space-y-1.5 text-sm">
          {entries.map(([key, value]) => (
            <div key={key} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3">
              <dt className="text-slate-500">{labels.get(key) ?? key.replace(/_/g, " ")}</dt>
              <dd className="whitespace-pre-wrap break-words text-slate-800">{String(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/** A store added from the Dolphin data has no IBC#: enter it once here (it is fixed after that, like any IBC#). */
function ExternalIdInput({ projectId, uid }: { projectId: string; uid: string }) {
  const [value, setValue] = useState("");
  const save = useSetExternalId(projectId);
  return (
    <div className="space-y-1.5">
      <Label htmlFor="store-external_id" className="flex items-center gap-1 text-amber-800">
        <AlertTriangle size={12} /> IBC# (missing)
      </Label>
      <form
        className="flex gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(
            { uid, externalId: value.trim() },
            {
              onSuccess: (stop) => toast.success(`IBC# ${stop.external_id} saved`),
              onError: (error) => toast.error(error instanceof Error ? error.message : "Could not save the IBC#"),
            },
          );
        }}
      >
        <Input id="store-external_id" value={value} placeholder="e.g. FL18993" onChange={(event) => setValue(event.target.value.toUpperCase())} aria-invalid />
        <Button type="submit" variant="outline" disabled={!value.trim() || save.isPending}>
          {save.isPending && <Loader2 className="animate-spin" />} Save
        </Button>
      </form>
      <p className="text-xs text-slate-500">The Dolphin data has no IBC# for this store. It cannot be changed once saved.</p>
    </div>
  );
}
