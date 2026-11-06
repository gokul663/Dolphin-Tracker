import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Cable, Check, Eye, EyeOff, Loader2, Lock, Pencil, Send, Signal, Wifi } from "lucide-react";
import { toast } from "sonner";
import { NameField } from "@/components/NameField";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useCategories } from "@/features/lists/api";
import { todayIso } from "@/features/planner/planModel";
import { useStoreFields } from "@/features/places/api";
import { useStore, useUpdateStoreDetails } from "@/features/stores/api";
import { useCreateVisit, useVisits } from "@/features/visits/api";
import {
  LOCKED_GROUPS,
  lockedPatch,
  lockedValues,
  formErrors,
  formFor,
  NETWORK_TYPES,
  REPLACED_WITH,
  toInput,
  type LockedKey,
  type LockedValues,
  type VisitForm,
} from "@/features/visits/visitForm";
import { keys } from "@/lib/api/keys";
import { projectsApi } from "@/lib/api/resources";
import type { NetworkType, Project, Stop, StoreFieldSpec, Visit } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";
import { cn } from "@/lib/utils";

const MANAGER_KEY = "dolphin-tracker.last-manager";
const NETWORK_ICONS: Record<NetworkType, typeof Wifi> = { WiFi: Wifi, Ethernet: Cable, LTE: Signal };

interface Props {
  projectId: string | null;
  stopUid: string | null;
  /** The plan the visit is logged from ("" = the store's active plan, if any). */
  planId?: string;
  installer?: string;
  visitDate?: string | null;
  onClose: () => void;
}

function Section({ title, accent, children, action }: { title: string; accent: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="space-y-4 rounded-xl border bg-white p-5 shadow-sm" aria-label={title}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="border-l-4 pl-3 text-lg font-semibold" style={{ borderColor: accent }}>
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
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

/** New Log Entry for one stick, beside a read-only panel of everything else the store has, and its history. */
export function VisitPanel({ projectId, stopUid, planId = "", installer = "", visitDate, onClose }: Props) {
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
      <DialogContent className="flex max-h-[94vh] flex-col gap-0 p-0 sm:max-w-[min(1300px,96vw)]">
        <DialogHeader className="border-b px-6 pt-5 pb-3 pr-12">
          <DialogTitle className="text-xl">New Log Entry</DialogTitle>
          <DialogDescription>
            {stop ? `${stop.store_name}${stop.external_id ? ` · ${stop.external_id}` : ""} · one entry per stick` : "Loading the store…"}
          </DialogDescription>
        </DialogHeader>
        {stop && project.data ? (
          <VisitBody
            key={stop.uid}
            stop={stop}
            project={project.data}
            planId={planId}
            installer={installer}
            visitDate={visitDate ?? todayIso()}
          />
        ) : (
          <div className="p-10 text-center font-mono text-sm text-slate-500">{store.isError ? `Could not load the store: ${store.error.message}` : "Loading…"}</div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function VisitBody({ stop, project, planId, installer, visitDate }: { stop: Stop; project: Project; planId: string; installer: string; visitDate: string }) {
  const categories = useCategories();
  const create = useCreateVisit(project.id, stop.uid);
  const [manager, setManager] = useState(() => window.localStorage.getItem(MANAGER_KEY) ?? "");
  const firstOpen = stop.screens.find((screen) => !stop.screen_visits[screen.id] || stop.screen_visits[screen.id]! < stop.last_planned_at) ?? stop.screens[0]!;
  const [screenId, setScreenId] = useState(firstOpen.id);
  const screen = stop.screens.find((s) => s.id === screenId) ?? stop.screens[0]!;
  const [form, setForm] = useState<VisitForm>(() => formFor(stop, screen, { installer, manager, date: visitDate }));
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    setForm((current) => ({ ...formFor(stop, screen, { installer, manager: current.dolphin_manager || manager, date: current.visit_date || visitDate }) }));
    setTouched(false);
    // A new stick starts a fresh entry; the manager and date carry over. Only a stick change resets the form.
  }, [screenId]);

  const tree = categories.data ?? [];
  const errors = formErrors(form, tree);
  const subcategories = tree.find((entry) => entry.name === form.category)?.subcategories ?? [];
  const set = (patch: Partial<VisitForm>) => setForm((current) => ({ ...current, ...patch }));
  const shown = (key: string) => (touched ? errors[key] : undefined);

  const submit = async () => {
    setTouched(true);
    if (Object.keys(errors).length) {
      toast.error("Fill in the required fields");
      return;
    }
    try {
      await create.mutateAsync(toInput(form, planId));
      window.localStorage.setItem(MANAGER_KEY, form.dolphin_manager.trim());
      setManager(form.dolphin_manager.trim());
      toast.success(`Logged ${form.stick_number || "the stick"} at ${stop.store_name}`);
      const next = stop.screens.find((s) => s.id !== screenId && (!stop.screen_visits[s.id] || stop.screen_visits[s.id]! < stop.last_planned_at));
      if (next) setScreenId(next.id);
      else setForm(formFor(stop, screen, { installer: form.installer, manager: form.dolphin_manager, date: form.visit_date }));
      setTouched(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the visit");
    }
  };

  return (
    <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_380px] lg:overflow-hidden">
      <div className="space-y-5 bg-slate-50 p-5 lg:overflow-y-auto">
        {stop.screens.length > 1 && (
          <div role="tablist" aria-label="Sticks" className="flex flex-wrap gap-1.5">
            {stop.screens.map((s, index) => {
              const logged = Boolean(stop.screen_visits[s.id]) && stop.screen_visits[s.id]! >= stop.last_planned_at;
              return (
                <button
                  key={s.id}
                  role="tab"
                  aria-selected={s.id === screenId}
                  onClick={() => setScreenId(s.id)}
                  className={cn("flex items-center gap-1.5 rounded-lg border-2 bg-white px-3 py-1.5 text-xs", s.id === screenId ? "border-brand" : "border-slate-200")}
                >
                  {logged && <Check className="size-3.5 text-emerald-600" aria-label="visited" />}
                  Stick {index + 1}
                  <span className="font-mono text-[10px] text-slate-500">{[s.stick_number, s.venue_id].filter(Boolean).join(" · ") || "no number"}</span>
                </button>
              );
            })}
          </div>
        )}

        <Section title="Location Details" accent="#0F5B7C">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Date" required error={shown("visit_date")} htmlFor="visit-date">
              <Input id="visit-date" type="date" value={form.visit_date} onChange={(e) => set({ visit_date: e.target.value })} />
            </Field>
            <Field label="DD_Code" required error={shown("dd_code")} htmlFor="visit-dd">
              <Input id="visit-dd" placeholder="e.g., DD_H39CLM" value={form.dd_code} onChange={(e) => set({ dd_code: e.target.value })} />
            </Field>
            <Field label="Venue Name" required error={shown("venue_name")} htmlFor="visit-venue">
              <Input id="visit-venue" placeholder="e.g., D_005_00746_KIOSK" value={form.venue_name} onChange={(e) => set({ venue_name: e.target.value })} />
            </Field>
            <Field label="Store name">
              <Input value={stop.store_name} readOnly className="bg-slate-50" aria-label="Store name" />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Address">
                <Input value={[stop.addr, stop.city, stop.state, stop.zip].filter(Boolean).join(", ")} readOnly className="bg-slate-50" aria-label="Address" />
              </Field>
            </div>
          </div>
        </Section>

        <Section title="Personnel & Equipment" accent="#0ea5e9">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="PA">
              <Input value={stop.pa || project.pa} readOnly className="bg-slate-50" aria-label="PA" />
            </Field>
            <Field label="FA">
              <Input value={project.field_agent} readOnly className="bg-slate-50" aria-label="FA" placeholder="No field agent" />
            </Field>
            <Field label="Installer" required error={shown("installer")}>
              <NameField kind="installers" aria-label="Installer" placeholder="Select or type installer name" value={form.installer} onChange={(value) => set({ installer: value })} />
            </Field>
            <Field label="Stick number" required error={shown("stick_number")} htmlFor="visit-stick">
              <Input id="visit-stick" placeholder="Stick number" value={form.stick_number} onChange={(e) => set({ stick_number: e.target.value })} />
            </Field>
            <Field label="Dolphin Manager" required error={shown("dolphin_manager")}>
              <NameField kind="managers" aria-label="Dolphin Manager" placeholder="Select or type manager name" value={form.dolphin_manager} onChange={(value) => set({ dolphin_manager: value })} />
            </Field>
          </div>
        </Section>

        <Section title="Network Details" accent="#8b5cf6">
          <Field label="Network Type" required error={shown("network_type")}>
            <div role="radiogroup" aria-label="Network Type" className="grid grid-cols-3 gap-3">
              {NETWORK_TYPES.map((type) => {
                const Icon = NETWORK_ICONS[type];
                return (
                  <button
                    key={type}
                    type="button"
                    role="radio"
                    aria-checked={form.network_type === type}
                    onClick={() => set({ network_type: type })}
                    className={cn(
                      "flex h-20 flex-col items-center justify-center gap-1.5 rounded-lg border-2 text-sm",
                      form.network_type === type ? "border-brand bg-brand/10 text-brand" : "border-slate-200 text-slate-600",
                    )}
                  >
                    <Icon className="size-5" /> {type}
                  </button>
                );
              })}
            </div>
          </Field>
          <div className="border-t" />
          <LockedGroup stop={stop} projectId={project.id} title="Store WiFi" fields={LOCKED_GROUPS.wifi} />
        </Section>

        <Section title="Software Requirements" accent="#8b5cf6">
          <div className="grid gap-4 sm:grid-cols-2">
            <YesNo label="Latest APK" value={form.latest_apk} onChange={(latest_apk) => set({ latest_apk })} error={shown("latest_apk")} />
            <YesNo label="Set Kiosk Mode" value={form.kiosk_mode} onChange={(kiosk_mode) => set({ kiosk_mode })} error={shown("kiosk_mode")} />
          </div>
        </Section>

        <Section title="Issue Details" accent="#10b981">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Category" required error={shown("category")}>
              <Select value={form.category} onValueChange={(category) => set({ category, subcategory: "", replaced_with: "" })}>
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
              <Select value={form.subcategory} onValueChange={(subcategory) => set({ subcategory })} disabled={!form.category}>
                <SelectTrigger aria-label="Subcategory" className="w-full">
                  <SelectValue placeholder={form.category ? "Select subcategory" : "Pick a category first"} />
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
            {REPLACED_WITH.has(form.subcategory) && (
              <Field label="Replaced with" required error={shown("replaced_with")} htmlFor="visit-replaced">
                <Input id="visit-replaced" placeholder="New stick or screen number" value={form.replaced_with} onChange={(e) => set({ replaced_with: e.target.value })} />
              </Field>
            )}
          </div>
          <Field label="Detailed Comments" htmlFor="visit-comments">
            <Textarea
              id="visit-comments"
              rows={4}
              disabled={!form.subcategory}
              placeholder={form.subcategory ? "What was found and done" : "Select a category first…"}
              value={form.comments}
              onChange={(e) => set({ comments: e.target.value })}
            />
          </Field>
        </Section>

        <Section title="Contact" accent="#64748b">
          <LockedGroup stop={stop} projectId={project.id} title="Owner" fields={LOCKED_GROUPS.owner} />
          <div className="border-t" />
          <LockedGroup stop={stop} projectId={project.id} title="Store Contact" fields={LOCKED_GROUPS.storeContact} />
        </Section>

        <div className="flex items-center justify-between gap-3">
          <p className="font-mono text-[11px] text-slate-500">
            Logging a visit never changes the stick's status ({STATUS_META[screen.status].label}). Change status in the store.
          </p>
          <Button size="lg" onClick={() => void submit()} disabled={create.isPending}>
            {create.isPending ? <Loader2 className="animate-spin" /> : <Send />} Submit Log Entry
          </Button>
        </div>
      </div>
      <aside className="space-y-4 border-l bg-white p-5 lg:overflow-y-auto" aria-label="Store details (read only)">
        <StoreSideNotes stop={stop} project={project} />
        <VisitHistory projectId={project.id} stop={stop} />
      </aside>
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
function LockedGroup({ stop, projectId, title, fields }: { stop: Stop; projectId: string; title: string; fields: readonly LockedField[] }) {
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
    <div role="group" aria-label={title} className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
          {!editing && <Lock className="size-3.5 text-slate-400" aria-label="locked" />} {title}
        </h4>
        {editing ? (
          <div className="flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={update.isPending} aria-label={`Save ${title}`}>
              {update.isPending && <Loader2 className="animate-spin" />} Save
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)} aria-label={`Edit ${title}`}>
            <Pencil /> Edit
          </Button>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {fields.map(({ key, label, secret }) => (
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

const SIDE_GROUPS: StoreFieldSpec["group"][] = ["Site notes", "Site checklist", "Installation", "Identity & address", "Pictures"];
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
    <div className="space-y-4 text-sm">
      <h3 className="font-mono text-[11px] uppercase tracking-wider text-slate-500">From the sheet (read only)</h3>
      {groups.length === 0 && extra.length === 0 && <p className="text-xs text-slate-500">Nothing else on file for this store.</p>}
      {groups.map(({ group, rows }) => (
        <section key={group} aria-label={group} className="space-y-1.5">
          <h4 className="text-xs font-semibold text-slate-700">{group}</h4>
          <dl className="space-y-1">
            {rows.map(({ spec, value }) => (
              <div key={spec.name} className="grid grid-cols-[120px_minmax(0,1fr)] gap-2">
                <dt className="text-xs text-slate-500">{spec.label}</dt>
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
        </section>
      ))}
      {extra.length > 0 && (
        <section aria-label="Other imported data" className="space-y-1.5">
          <h4 className="text-xs font-semibold text-slate-700">Other imported data</h4>
          <dl className="space-y-1">
            {extra.map(([key, value]) => (
              <div key={key} className="grid grid-cols-[120px_minmax(0,1fr)] gap-2">
                <dt className="text-xs text-slate-500">{labels.get(key) ?? key}</dt>
                <dd className="break-words text-xs whitespace-pre-wrap">{String(value)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}

/** The store's servicing history: every visit, newest first, with its stick. */
export function VisitHistory({ projectId, stop, bare = false }: { projectId: string; stop: Stop; bare?: boolean }) {
  const visits = useVisits(projectId, stop.uid);
  const stickLabel = (visit: Visit) => {
    const index = stop.screens.findIndex((screen) => screen.id === visit.screen_id);
    return index >= 0 ? `Stick ${index + 1}` : "Removed stick";
  };
  const Wrapper = bare ? "div" : "section";
  return (
    <Wrapper aria-label={bare ? undefined : "Servicing history"} className={cn("space-y-2", !bare && "border-t pt-4")}>
      {!bare && <h3 className="font-mono text-[11px] uppercase tracking-wider text-slate-500">Servicing history</h3>}
      {visits.isPending ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : visits.isError ? (
        <p className="text-xs text-rose-700">Could not load the history.</p>
      ) : visits.data.items.length === 0 ? (
        <p className="text-xs text-slate-500">No visits logged yet.</p>
      ) : (
        <ol className="space-y-2">
          {visits.data.items.map((visit) => (
            <li key={visit.id} className="rounded-lg border p-2.5 text-xs">
              <div className="flex flex-wrap items-baseline justify-between gap-1">
                <span className="font-semibold">{visit.visit_date}</span>
                <span className="font-mono text-[10px] text-slate-500">
                  {stickLabel(visit)} · {visit.stick_number} · {visit.dd_code}
                </span>
              </div>
              <div className="mt-1">
                {visit.category} › {visit.subcategory}
                {visit.replaced_with ? ` → ${visit.replaced_with}` : ""}
              </div>
              <div className="mt-0.5 text-slate-500">
                {visit.installer} · managed by {visit.dolphin_manager} · {visit.network_type} · APK {visit.latest_apk ? "yes" : "no"} · Kiosk{" "}
                {visit.kiosk_mode ? "yes" : "no"}
              </div>
              {visit.comments && <p className="mt-1 whitespace-pre-wrap text-slate-700">{visit.comments}</p>}
            </li>
          ))}
        </ol>
      )}
    </Wrapper>
  );
}
