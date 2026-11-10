import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useRoutePlans } from "@/features/planner/api";
import { VisitHistory, VisitPanel } from "@/features/visits/VisitPanel";
import { AlertTriangle, ChevronRight, ClipboardCheck, ChevronsDownUp, ChevronsUpDown, Eye, EyeOff, ImageOff, Loader2, MapPin, Undo2, Wifi } from "lucide-react";
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
import { ScreensEditor } from "@/features/stores/ScreensEditor";
import { StoreDeviceSection } from "@/features/device/StoreDeviceSection";
import { useSetExternalId, useStore, useUpdateProgress, useUpdateStoreDetails } from "@/features/stores/api";
import {
  actualCounts,
  addressChanged,
  detailsErrors,
  detailsFormFrom,
  detailsPatch,
  filledCount,
  previewSrc,
  type DetailsForm,
  type FormValue,
} from "@/features/stores/details";
import { ApiError, type Project, type Stop, type StoreFieldSpec } from "@/lib/api/types";
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
/** Detail groups in modal order: WiFi first (what the installer needs on site), the screen counts last. Pictures
 *  are a detail too but come at the very end, after the screens and progress. */
const DETAIL_GROUPS: Group[] = ["WiFi", "Identity & address", "Contacts", "Installation", "Site notes", "Site checklist"];
const SECTIONS = [...DETAIL_GROUPS, "Screen counts", "Screens", "Servicing history", "Progress", "Other imported data", "Pictures"] as const;
type SectionName = (typeof SECTIONS)[number];
const DEFAULT_OPEN: SectionName[] = ["WiFi", "Identity & address", "Screens", "Servicing history", "Pictures"];

interface Sections {
  isOpen: (name: SectionName) => boolean;
  toggle: (name: SectionName) => void;
}

/** Full editor for one store in a large modal: collapsible sections in STORE-MODEL §3 order with WiFi first —
 *  details (geocoded on address change), screens, progress, other imported data, then the pictures. */
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
  const planNames = new Map((plans.data ?? []).map((plan) => [plan.id, plan.name]));
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[92vh] flex-col gap-0 p-0 sm:max-w-5xl">
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
            >
              <Section title="Screens" sections={sections}>
                {/* Reset only when the saved rows change, so saving details keeps unsaved screen edits. */}
                <ScreensEditor key={`${stop.uid}-${JSON.stringify(stop.screens)}`} project={project} stop={stop} />
              </Section>
              <Section title="Servicing history" sections={sections}>
                <VisitHistory projectId={project.id} stop={stop} bare />
              </Section>
              <Section title="Progress" sections={sections}>
                <ProgressForm project={project} stop={stop} />
              </Section>
              <OtherData project={project} stop={stop} sections={sections} />
            </DetailsEditor>
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

/** A collapsible section. Closed content stays mounted (hidden), so unsaved edits inside it survive a collapse;
 *  `forceOpen` keeps a section with a validation problem visible. */
function Section({
  title,
  sections,
  hint,
  forceOpen = false,
  icon,
  className,
  children,
}: {
  title: SectionName;
  sections: Sections;
  hint?: string;
  forceOpen?: boolean;
  icon?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const open = forceOpen || sections.isOpen(title);
  const bodyId = `store-section-${title.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <section className={cn("rounded-lg border", className)} aria-label={title}>
      <h3>
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
      <div id={bodyId} hidden={!open} className="space-y-3 border-t p-3">
        {children}
      </div>
    </section>
  );
}

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
  children,
}: {
  project: Project;
  stop: Stop;
  specs: StoreFieldSpec[];
  sections: Sections;
  /** The sections between the screen counts and the pictures (screens, progress, other data). */
  children: React.ReactNode;
}) {
  const [form, setForm] = useState<DetailsForm>(() => detailsFormFrom(stop, specs));
  const [touched, setTouched] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [geoProblem, setGeoProblem] = useState<{ message: string; suggestions: string[] } | null>(null);
  const update = useUpdateStoreDetails(project.id);
  const validate = useValidateAddress();
  const errors = { ...(touched ? detailsErrors(form, specs) : {}), ...serverErrors };
  const patch = detailsPatch(stop, form, specs);
  const dirty = Object.keys(patch).length > 0;
  const counts = actualCounts(stop.screens);
  const groupOf = new Map(specs.map((spec) => [spec.name, spec.group]));
  const failing = new Set(Object.keys(errors).map((name) => groupOf.get(name)));
  const groupSpecs = (group: Group) => specs.filter((spec) => spec.group === group);
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

  const save = async (place?: PlaceHit) => {
    setTouched(true);
    if (Object.keys(detailsErrors(form, specs)).length) return;
    setGeoProblem(null);
    try {
      const body = place ? { ...patch, place: { lat: place.lat, lng: place.lng, formatted: [place.name, place.formatted].filter(Boolean).join(" · ") } } : patch;
      await update.mutateAsync({ uid: stop.uid, body });
      setBeforePick(null);
      toast.success(addressChanged(patch) ? "Address verified and saved; the route is marked for re-optimising" : "Store saved");
    } catch (error) {
      const detail = error instanceof ApiError ? error.validation : null;
      if (detail?.suggestions !== undefined) setGeoProblem({ message: detail.message, suggestions: detail.suggestions });
      else if (detail?.fields) setServerErrors(detail.fields);
      else toast.error(error instanceof Error ? error.message : "Save failed");
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

  return (
    <div className="space-y-3 pt-4">
      <StoreDeviceSection project={project} stop={stop} />
      {DETAIL_GROUPS.map((group) => (
        <Section
          key={group}
          title={group}
          sections={sections}
          hint={hint(group)}
          forceOpen={failing.has(group) || (group === "Identity & address" && geoProblem !== null)}
          icon={group === "WiFi" ? <Wifi size={13} /> : undefined}
          className={group === "WiFi" ? "border-sky-200 bg-sky-50/40" : undefined}
        >
          <div className={cn("grid gap-3", group === "Site checklist" ? "" : "sm:grid-cols-2 lg:grid-cols-3")}>
            {groupSpecs(group).map(control)}
          </div>
          {group === "Identity & address" && (
            <>
              {stop.geocoded && (
                <p className="flex items-center gap-1 text-xs text-slate-500">
                  <MapPin size={12} /> Verified as {stop.geocoded}
                </p>
              )}
              {stop.route_stale && (
                <p className="flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                  <AlertTriangle size={12} /> The address changed after routing; rebuild routes to re-optimise.
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
      ))}
      <Section title="Screen counts" sections={sections} forceOpen={failing.has("Screens")}>
        <div className="grid gap-3 sm:grid-cols-2">
          {groupSpecs("Screens").map((spec) => (
            <div key={spec.name} className="space-y-1">
              {control(spec)}
              <p className="text-xs text-slate-500">
                Actual: {spec.name === "committed_dolphin_screens" ? counts.dolphin : counts.tvs} (from the screen rows)
              </p>
            </div>
          ))}
        </div>
      </Section>
      {children}
      <Section title="Pictures" sections={sections} forceOpen={failing.has("Pictures")}>
        <div className="grid gap-3">{groupSpecs("Pictures").map(control)}</div>
      </Section>
      <div className="sticky bottom-0 -mx-6 flex justify-end gap-2 border-t bg-white px-6 py-3">
        <Button variant="ghost" disabled={!dirty} onClick={() => setForm(detailsFormFrom(stop, specs))}>
          Discard
        </Button>
        <Button onClick={() => void save()} disabled={!dirty || update.isPending}>
          {update.isPending && <Loader2 className="animate-spin" />} {addressChanged(patch) ? "Verify address and save" : "Save details"}
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
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(urls), 400);
    return () => window.clearTimeout(timer);
  }, [key]); // the list is rebuilt on every render; its text is what changes
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label={`${label} links`}>
      {shown.map((url) => (
        <li key={url}>
          <ImagePreview url={url} />
        </li>
      ))}
    </ul>
  );
}

function ImagePreview({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <a href={url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border bg-slate-50 hover:border-brand">
      {failed ? (
        <span className="flex h-40 flex-col items-center justify-center gap-1 p-3 text-center text-xs text-slate-500">
          <ImageOff size={18} /> No preview for this link. Open it
        </span>
      ) : (
        <img
          src={previewSrc(url)}
          alt="Store picture"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="h-48 w-full object-cover"
        />
      )}
      <span className="block truncate border-t px-2 py-1 text-xs text-brand">{url}</span>
    </a>
  );
}

function ProgressForm({ project, stop }: { project: Project; stop: Stop }) {
  const progress = useUpdateProgress(project.id);
  const [comment, setComment] = useState(stop.comment);
  const [installerName, setInstallerName] = useState(stop.installer_name);
  useEffect(() => setComment(stop.comment), [stop.comment]);
  useEffect(() => setInstallerName(stop.installer_name), [stop.installer_name]);
  const save = (body: Parameters<typeof progress.mutate>[0]["body"]) =>
    progress.mutate(
      { uid: stop.uid, body },
      { onError: (error) => toast.error(error instanceof Error ? error.message : "Could not save progress") },
    );
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="installer-name">Completed by</Label>
        <Input
          id="installer-name"
          list="installer-options"
          value={installerName}
          onChange={(event) => setInstallerName(event.target.value)}
          onBlur={() => installerName !== stop.installer_name && save({ installer_name: installerName.trim() })}
        />
        <datalist id="installer-options">
          {["self install", ...project.installers].map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="additional-task" checked={stop.additional_task} onCheckedChange={(checked) => save({ additional_task: checked === true })} />
        <Label htmlFor="additional-task">Additional task done</Label>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="comment">Comment</Label>
        <Textarea id="comment" value={comment} onChange={(event) => setComment(event.target.value)} onBlur={() => comment !== stop.comment && save({ comment })} rows={3} />
      </div>
    </div>
  );
}

/** Columns the import did not recognise (`fields`), read-only (STORE-MODEL §3.8). */
function OtherData({ project, stop, sections }: { project: Project; stop: Stop; sections: Sections }) {
  const labels = new Map(project.field_schema.map((field) => [field.key, field.label]));
  const entries = Object.entries(stop.fields).filter(([, value]) => value !== null && value !== undefined && value !== "");
  return (
    <Section title="Other imported data" sections={sections} hint={entries.length ? `${entries.length} values` : undefined}>
      {entries.length === 0 ? (
        <p className="text-sm text-slate-400">Nothing else came with this store.</p>
      ) : (
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          {entries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="truncate text-slate-500">{labels.get(key) ?? key.replace(/_/g, " ")}</dt>
              <dd className="whitespace-pre-wrap break-words">{String(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </Section>
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
