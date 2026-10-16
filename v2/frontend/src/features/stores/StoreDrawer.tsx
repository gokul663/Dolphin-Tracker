import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, MapPin } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useValidateAddress } from "@/features/places/api";
import { useStore, useUpdateProgress, useUpdateStoreDetails } from "@/features/stores/api";
import { addressChanged, detailsErrors, detailsFormFrom, detailsPatch, type DetailsForm } from "@/features/stores/details";
import { ApiError, STOP_STATUSES, type FieldDef, type Project, type Stop } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";

interface Props {
  project: Project;
  stopId: string | null;
  open: boolean;
  onClose: () => void;
}

/** Full editor for one store: details (geocoded on address change) and field progress. */
export function StoreDrawer({ project, stopId, open, onClose }: Props) {
  const store = useStore(project.id, open ? stopId : null);
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="font-mono uppercase tracking-wider text-brand">
            {store.data ? `${store.data.display_id} · ${store.data.store_name}` : "Store"}
          </SheetTitle>
          <SheetDescription>
            {store.data?.installer ? `${store.data.installer} · day ${store.data.day}` : "Not assigned to a route yet"}
          </SheetDescription>
        </SheetHeader>
        {store.isPending && open && <p className="p-4 text-sm text-slate-500">Loading…</p>}
        {store.isError && <p className="p-4 text-sm text-rose-700">{store.error.message}</p>}
        {store.data && (
          <div className="space-y-6 px-4 pb-6">
            <ProgressForm project={project} stop={store.data} />
            <DetailsEditor key={store.data.uid} project={project} stop={store.data} />
          </div>
        )}
      </SheetContent>
    </Sheet>
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
    <section className="space-y-3 rounded-lg border p-3">
      <h3 className="font-mono text-[11px] uppercase tracking-wider text-slate-500">Field progress</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Status</Label>
          <Select value={stop.status} onValueChange={(value) => save({ status: value as Stop["status"] })}>
            <SelectTrigger aria-label="Status" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STOP_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  <span className="size-2 rounded-full" style={{ background: STATUS_META[status].color }} />
                  {STATUS_META[status].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
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
            {project.installers.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id="additional-task"
          checked={stop.additional_task}
          onCheckedChange={(checked) => save({ additional_task: checked === true })}
        />
        <Label htmlFor="additional-task">Additional task done</Label>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="comment">Comment</Label>
        <Textarea
          id="comment"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          onBlur={() => comment !== stop.comment && save({ comment })}
          rows={3}
        />
      </div>
    </section>
  );
}

function FieldInput({ field, value, onChange, error }: { field: FieldDef; value: string; onChange: (v: string) => void; error?: string }) {
  const id = `field-${field.key}`;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {field.label}
        {field.required && " *"}
      </Label>
      {field.type === "select" ? (
        <Select value={value || undefined} onValueChange={onChange}>
          <SelectTrigger id={id} aria-label={field.label} className="w-full">
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          value={value}
          aria-invalid={Boolean(error)}
          type={field.type === "date" ? "date" : field.type === "email" ? "email" : field.type === "phone" ? "tel" : "text"}
          inputMode={field.type === "number" ? "decimal" : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {error && <p className="text-xs text-rose-600">{error}</p>}
    </div>
  );
}

function DetailsEditor({ project, stop }: { project: Project; stop: Stop }) {
  const schema = project.field_schema;
  const [form, setForm] = useState<DetailsForm>(() => detailsFormFrom(stop, schema));
  const [touched, setTouched] = useState(false);
  const [geoProblem, setGeoProblem] = useState<{ message: string; suggestions: string[] } | null>(null);
  const update = useUpdateStoreDetails(project.id);
  const validate = useValidateAddress();
  const errors = touched ? detailsErrors(form, schema) : {};
  const patch = detailsPatch(stop, form, schema);
  const dirty = Object.keys(patch).length > 0;

  const set = (key: keyof Omit<DetailsForm, "fields">, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const setField = (key: string, value: string) =>
    setForm((current) => ({ ...current, fields: { ...current.fields, [key]: value } }));

  const save = async () => {
    setTouched(true);
    if (Object.keys(detailsErrors(form, schema)).length) return;
    setGeoProblem(null);
    try {
      await update.mutateAsync({ uid: stop.uid, body: patch });
      toast.success(addressChanged(patch) ? "Address verified and saved; the route is marked for re-optimising" : "Store saved");
    } catch (error) {
      const detail = error instanceof ApiError ? error.validation : null;
      if (detail?.suggestions !== undefined) setGeoProblem({ message: detail.message, suggestions: detail.suggestions });
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

  return (
    <section className="space-y-3">
      <h3 className="font-mono text-[11px] uppercase tracking-wider text-slate-500">Store details</h3>
      <div className="space-y-1.5">
        <Label htmlFor="store-name">Store name *</Label>
        <Input id="store-name" value={form.store_name} aria-invalid={Boolean(errors.store_name)} onChange={(e) => set("store_name", e.target.value)} />
        {errors.store_name && <p className="text-xs text-rose-600">{errors.store_name}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="store-addr">Address *</Label>
        <Input id="store-addr" value={form.addr} aria-invalid={Boolean(errors.addr)} onChange={(e) => set("addr", e.target.value)} />
        {errors.addr && <p className="text-xs text-rose-600">{errors.addr}</p>}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {(["city", "state", "zip"] as const).map((key) => (
          <div key={key} className="space-y-1.5">
            <Label htmlFor={`store-${key}`} className="capitalize">
              {key === "zip" ? "ZIP" : key}
            </Label>
            <Input id={`store-${key}`} value={form[key]} onChange={(e) => set(key, e.target.value)} />
          </div>
        ))}
      </div>
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
      <div className="grid gap-3 sm:grid-cols-2">
        {schema.map((field) => (
          <FieldInput
            key={field.key}
            field={field}
            value={form.fields[field.key] ?? ""}
            onChange={(value) => setField(field.key, value)}
            error={errors[`fields.${field.key}`]}
          />
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={!dirty} onClick={() => setForm(detailsFormFrom(stop, schema))}>
          Discard
        </Button>
        <Button onClick={save} disabled={!dirty || update.isPending}>
          {update.isPending && <Loader2 className="animate-spin" />} {addressChanged(patch) ? "Verify address and save" : "Save"}
        </Button>
      </div>
    </section>
  );
}
