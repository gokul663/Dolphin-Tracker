import { useEffect, useState } from "react";
import { AlertTriangle, Eye, EyeOff, Loader2, MapPin } from "lucide-react";
import { toast } from "sonner";
import { TriStateCheckbox } from "@/components/TriStateCheckbox";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useStoreFields, useValidateAddress } from "@/features/places/api";
import { ScreensEditor } from "@/features/stores/ScreensEditor";
import { useStore, useUpdateProgress, useUpdateStoreDetails } from "@/features/stores/api";
import {
  actualCounts,
  addressChanged,
  detailsErrors,
  detailsFormFrom,
  detailsPatch,
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
const DETAIL_GROUPS: Group[] = ["Identity & address", "Contacts", "Installation", "Site notes", "Site checklist"];

/** Full editor for one store, in STORE-MODEL §3 order: details (geocoded on address change), screens, progress,
 *  other imported data. */
export function StoreDrawer({ project, stopId, open, onClose }: Props) {
  const store = useStore(project.id, open ? stopId : null);
  const specs = useStoreFields();
  const stop = store.data;
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="font-mono uppercase tracking-wider text-brand">
            {stop ? `${stop.external_id || stop.display_id} · ${stop.store_name}` : "Store"}
          </SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-2">
            {stop && (
              <span className={cn("rounded border px-1.5 py-0.5 text-xs font-medium", STATUS_META[stop.status].chip)}>
                {STATUS_META[stop.status].label}
              </span>
            )}
            {stop?.installer ? `${stop.installer} · day ${stop.day}` : "Not assigned to a route yet"}
          </SheetDescription>
        </SheetHeader>
        {(store.isPending || specs.isPending) && open && <p className="p-4 text-sm text-slate-500">Loading…</p>}
        {store.isError && <p className="p-4 text-sm text-rose-700">{store.error.message}</p>}
        {specs.isError && <p className="p-4 text-sm text-rose-700">Could not load the store fields: {specs.error.message}</p>}
        {stop && specs.data && (
          <div className="space-y-6 px-4 pb-6">
            <DetailsEditor key={`${stop.uid}-details`} project={project} stop={stop} specs={specs.data} />
            <Section title="Screens">
              {/* Reset only when the saved rows change, so saving details keeps unsaved screen edits. */}
              <ScreensEditor key={`${stop.uid}-${JSON.stringify(stop.screens)}`} project={project} stop={stop} />
            </Section>
            <Section title="Progress">
              <ProgressForm project={project} stop={stop} />
            </Section>
            <OtherData project={project} stop={stop} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3" aria-label={title}>
      <h3 className="border-b pb-1 font-mono text-[11px] uppercase tracking-wider text-slate-500">{title}</h3>
      {children}
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
    <div className={cn("space-y-1.5", spec.kind === "multiline" || spec.kind === "url" ? "sm:col-span-2" : "")}>
      <Label htmlFor={id}>
        {spec.label}
        {spec.required && " *"}
      </Label>
      {control}
      {links.length > 0 && (
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

function DetailsEditor({ project, stop, specs }: { project: Project; stop: Stop; specs: StoreFieldSpec[] }) {
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

  const set = (name: string, value: FormValue) => {
    setForm((current) => ({ ...current, [name]: value }));
    setServerErrors(({ [name]: _gone, ...rest }) => rest);
  };

  const save = async () => {
    setTouched(true);
    if (Object.keys(detailsErrors(form, specs)).length) return;
    setGeoProblem(null);
    try {
      await update.mutateAsync({ uid: stop.uid, body: patch });
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
      const geo = await validate.mutateAsync(suggestion);
      if (!geo.ok) return toast.error("That suggestion could not be verified either");
      setForm((current) => ({ ...current, addr: geo.addr, city: geo.city, state: geo.state, zip: geo.zip }));
      setGeoProblem(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not check the suggestion");
    }
  };

  const control = (spec: StoreFieldSpec) =>
    spec.editable ? (
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
    <div className="space-y-6">
      {DETAIL_GROUPS.map((group) => (
        <Section key={group} title={group}>
          <div className={cn("grid gap-3", group === "Site checklist" ? "" : "sm:grid-cols-2")}>
            {specs.filter((spec) => spec.group === group).map(control)}
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
                </div>
              )}
            </>
          )}
        </Section>
      ))}
      <Section title="Screen counts">
        <div className="grid gap-3 sm:grid-cols-2">
          {specs
            .filter((spec) => spec.group === "Screens")
            .map((spec) => (
              <div key={spec.name} className="space-y-1">
                {control(spec)}
                <p className="text-xs text-slate-500">
                  Actual: {spec.name === "committed_dolphin_screens" ? counts.dolphin : counts.tvs} (from the screen rows)
                </p>
              </div>
            ))}
        </div>
      </Section>
      <div className="sticky bottom-0 flex justify-end gap-2 border-t bg-white py-2">
        <Button variant="ghost" disabled={!dirty} onClick={() => setForm(detailsFormFrom(stop, specs))}>
          Discard
        </Button>
        <Button onClick={save} disabled={!dirty || update.isPending}>
          {update.isPending && <Loader2 className="animate-spin" />} {addressChanged(patch) ? "Verify address and save" : "Save details"}
        </Button>
      </div>
    </div>
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
function OtherData({ project, stop }: { project: Project; stop: Stop }) {
  const labels = new Map(project.field_schema.map((field) => [field.key, field.label]));
  const entries = Object.entries(stop.fields).filter(([, value]) => value !== null && value !== undefined && value !== "");
  return (
    <Section title="Other imported data">
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
