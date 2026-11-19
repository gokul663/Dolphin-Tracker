import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Cable, Check, ClipboardCheck, Eye, EyeOff, Loader2, Lock, Package, Pencil, Plus, Send, Signal, Trash2, Wifi } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
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
import { useStore, useUpdateProgress, useUpdateScreens, useUpdateStoreDetails } from "@/features/stores/api";
import { INSTALLED_STATUSES } from "@/features/stores/details";
import { newRow, ScreenFields, toInputs, toRows, type ScreenRow } from "@/features/stores/ScreensEditor";
import { computedMounts } from "@/features/stores/StoreSummary";
import { useCreateVisit, useVenue, useVisits } from "@/features/visits/api";
import {
  LOCKED_GROUPS,
  lockedPatch,
  lockedValues,
  formErrors,
  formFor,
  NETWORK_TYPES,
  REPLACED_WITH,
  screenOutcomes,
  toInput,
  venueNameOf,
  type LockedKey,
  type LockedValues,
  type VisitForm,
} from "@/features/visits/visitForm";
import { keys } from "@/lib/api/keys";
import { projectsApi } from "@/lib/api/resources";
import { STOP_STATUSES, type NetworkType, type Project, type ScreenStatus, type Stop, type StoreFieldSpec, type Visit } from "@/lib/api/types";
import { bucketOf, STATUS_META } from "@/lib/status";
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
  /** Opened from a route plan: the store with its screens as lines, each logged on its own (network, software,
   *  issue, comment, Done or Incomplete); the store's name, WiFi and all its servicing history on the right. */
  plan?: PlanVisit;
  onClose: () => void;
}

export interface PlanVisit {
  /** Where the stop stands in the plan now (worked out from its screens' log entries, or marked on the plan). */
  state: "done" | "incomplete" | "route";
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

/** New Log Entry for one stick, beside a read-only panel of everything else the store has, and its history. From
 *  a route plan (`plan`) the store's own page comes first: what to bring, who it is, its screens. */
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
      <DialogContent className="flex max-h-[94vh] flex-col gap-0 p-0 sm:max-w-[min(1300px,96vw)]">
        <DialogHeader className="border-b px-6 pt-5 pb-3 pr-12">
          <DialogTitle className="text-xl">{plan ? (stop ? stop.device?.store_name || stop.store_name : "Store") : "New Log Entry"}</DialogTitle>
          <DialogDescription>
            {stop
              ? plan
                ? [stop.external_id || stop.display_id, project.data?.name].filter(Boolean).join(" · ")
                : `${stop.store_name}${stop.external_id ? ` · ${stop.external_id}` : ""} · one entry per stick`
              : "Loading the store…"}
          </DialogDescription>
        </DialogHeader>
        {stop && project.data ? (
          plan ? (
            <PlanStore key={stop.uid} stop={stop} project={project.data} planId={planId} installer={installer} visitDate={visitDate ?? todayIso()} plan={plan} />
          ) : (
            <VisitBody key={stop.uid} stop={stop} project={project.data} planId={planId} installer={installer} visitDate={visitDate ?? todayIso()} />
          )
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

  const venue = useVenue(form.dd_code);
  const cmsName = venue.data?.screens[0]?.cms_name ?? "";
  useEffect(() => {
    // The CMS's venue name for the DD code, while the box is still empty (what is typed is never replaced).
    if (cmsName) setForm((current) => (current.venue_name.trim() ? current : { ...current, venue_name: cmsName }));
  }, [cmsName]);

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
    <>
    {/* Always in reach, above the form that scrolls. */}
    <div className="flex flex-wrap items-center gap-3 border-b bg-white px-5 py-2.5" role="toolbar" aria-label="Log entry actions">
      <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-500">
        Logging a visit never changes the stick's status ({STATUS_META[screen.status].label}). Change status in the store.
      </p>
      <Button size="lg" className="h-11 px-6 text-base" onClick={() => void submit()} disabled={create.isPending}>
        {create.isPending ? <Loader2 className="animate-spin" /> : <Send />} Submit Log Entry
      </Button>
    </div>
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
            <Field label="Technician" required error={shown("installer")}>
              <NameField kind="installers" aria-label="Technician" placeholder="Select or type technician name" value={form.installer} onChange={(value) => set({ installer: value })} />
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
          {form.network_type === "WiFi" && (
            <div role="group" aria-label="Other WiFi for this stick" className="space-y-3 rounded-lg border border-dashed p-3">
              <h4 className="text-sm font-semibold text-slate-700">This stick is on another WiFi</h4>
              <p className="-mt-2 text-xs text-slate-500">Only when it is not the store's WiFi above. Kept with this log entry.</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Other WiFi name (SSID)" htmlFor="visit-wifi-ssid">
                  <Input id="visit-wifi-ssid" autoComplete="off" value={form.wifi_ssid} onChange={(e) => set({ wifi_ssid: e.target.value })} />
                </Field>
                <Field label="Other WiFi password" htmlFor="visit-wifi-password">
                  <Input id="visit-wifi-password" autoComplete="off" value={form.wifi_password} onChange={(e) => set({ wifi_password: e.target.value })} />
                </Field>
              </div>
            </div>
          )}
        </Section>

        <Section title="Software Requirements" accent="#8b5cf6">
          <div className="grid gap-4 sm:grid-cols-3">
            <YesNo label="Latest APK" value={form.latest_apk} onChange={(latest_apk) => set({ latest_apk })} error={shown("latest_apk")} />
            <YesNo label="Set Kiosk Mode" value={form.kiosk_mode} onChange={(kiosk_mode) => set({ kiosk_mode })} error={shown("kiosk_mode")} />
            <YesNo label="Dagent installed" value={form.dagent_installed} onChange={(dagent_installed) => set({ dagent_installed })} error={shown("dagent_installed")} />
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
          <Field label="Comments for this screen" htmlFor="visit-comments">
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

      </div>
      <aside className="space-y-4 border-l bg-white p-5 lg:overflow-y-auto" aria-label="Store details (read only)">
        {/* What the CMS has for the DD code typed on the left: filled in as soon as the code is known. */}
        <StoreIdentity stop={stop} project={project} code={form.dd_code} />
        <StoreSideNotes stop={stop} project={project} />
        <VisitHistory projectId={project.id} stop={stop} />
      </aside>
    </div>
    </>
  );
}

/** Who the store is, read only. With a DD code (the store's first, or the one typed in the log entry) the values
 *  come from the Dolphin data (CMS) for that code: name, venue name, address, PA, DMA and status. Without one, or
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
    <section aria-label="Store" className="space-y-1.5 border-b pb-4 text-sm">
      <h3 className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
        Store · {venue.isFetching ? "looking up the DD code…" : cms ? `from the CMS (${lookup})` : lookup ? `${lookup} is not in the Dolphin data: the project's values` : "the project's values (no DD code yet)"}
      </h3>
      <dl className="space-y-1.5">
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
  const worked = computedMounts(stop.screens);
  // A number typed on the store goes over the one worked out from its screens.
  const mounts: [string, number][] = [
    ['Wall 24"', stop.wall_24_mounts_needed ?? worked.wall_24],
    ["Wall", stop.wall_mounts_needed ?? worked.wall],
    ["Ceiling", stop.ceiling_mounts_needed ?? worked.ceiling],
  ];
  return { sticks: upcoming.length, screens: [...screens], storeTvs: upcoming.filter((item) => !item.is_dolphin_screen).length, mounts: mounts.filter(([, count]) => count > 0) as [string, number][] };
}

function InventoryBand({ stop }: { stop: Stop }) {
  const need = inventoryNeeded(stop);
  if (!need) return null;
  const tile = "rounded-lg border bg-white px-3 py-2";
  const head = "font-mono text-[10px] uppercase tracking-wider text-slate-500";
  const list = (items: [string, number][], none: string) =>
    items.length ? (
      <ul className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-sm font-semibold text-slate-900">
        {items.map(([label, count]) => (
          <li key={label}>
            {count} × {label}
          </li>
        ))}
      </ul>
    ) : (
      <p className="mt-0.5 text-sm text-slate-400">{none}</p>
    );
  return (
    <section aria-label="Inventory needed" className="border-b bg-amber-50/60 px-5 py-3">
      <h3 className="mb-2 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-amber-900">
        <Package size={13} /> Inventory needed for the screens still to install
      </h3>
      <div className="grid gap-2 sm:grid-cols-3">
        <div className={tile}>
          <div className={head}>Sticks</div>
          <p className="mt-0.5 text-sm font-semibold text-slate-900">{need.sticks}</p>
        </div>
        <div className={tile}>
          <div className={head}>Screens</div>
          {list(need.screens, "None to bring")}
          {need.storeTvs > 0 && <p className="text-xs text-slate-500">+ {need.storeTvs} on the store's own TV (stick only)</p>}
        </div>
        <div className={tile}>
          <div className={head}>Mounts</div>
          {list(need.mounts, "None on file")}
        </div>
      </div>
    </section>
  );
}

const OUTCOME_LABEL = { done: "Done", incomplete: "Incomplete" } as const;
const OUTCOME_TONE = { done: "border-emerald-300 bg-emerald-50 text-emerald-800", incomplete: "border-amber-300 bg-amber-50 text-amber-800" } as const;

/** Who is logging and when: the same for every screen logged in this sitting. */
interface Who {
  visit_date: string;
  installer: string;
  dolphin_manager: string;
}

/** The store as a plan opens it. Left: what to bring, who is logging, the screens as lines (each opens its own log:
 *  what the screen is, network, software, issue, comment, Done or Incomplete; saving writes a log entry), then the
 *  store's comment and what was used. Right: who the store is (read only), its WiFi behind Edit, and
 *  the servicing history of every stick. */
function PlanStore({ stop, project, planId, installer, visitDate, plan }: { stop: Stop; project: Project; planId: string; installer: string; visitDate: string; plan: PlanVisit }) {
  const visits = useVisits(project.id, stop.uid).data?.items ?? [];
  const update = useUpdateScreens(project.id);
  const [who, setWho] = useState<Who>(() => ({ visit_date: visitDate, installer: installer || stop.installer_name || "", dolphin_manager: window.localStorage.getItem(MANAGER_KEY) ?? "" }));
  const [open, setOpen] = useState<string | null>(null); // the key of the line being logged
  const [adding, setAdding] = useState<ScreenRow | null>(null); // a screen not saved yet
  const [addedId, setAddedId] = useState<string | null>(null); // …or saved, while its log is still open
  const [removing, setRemoving] = useState<ScreenRow | null>(null);
  const saved = toRows(stop);
  const rows = [...saved.filter((row) => row.id !== addedId), ...(adding ? [adding] : [])];
  const outcomes = screenOutcomes(visits, planId);
  const logged = saved.filter((row) => outcomes.has(row.id ?? "")).length;
  const tone = plan.state === "route" ? "border-sky-300 bg-sky-50 text-sky-800" : OUTCOME_TONE[plan.state];
  const close = () => {
    setOpen(null);
    setAdding(null);
    setAddedId(null);
  };
  const remove = async (row: ScreenRow) => {
    setRemoving(null);
    try {
      await update.mutateAsync({ uid: stop.uid, screens: toInputs(saved.filter((item) => item.id !== row.id)), updatedBy: who.installer.trim() || "Route planner" });
      toast.success("Screen removed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove the screen");
    }
  };
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-b bg-white px-5 py-2.5">
        <span className={cn("inline-flex h-7 items-center rounded-md border px-2.5 text-xs font-medium", tone)} aria-label="Stop in the plan">
          {plan.state === "route" ? "In route" : OUTCOME_LABEL[plan.state]}
        </span>
        <span className={cn("inline-flex h-7 items-center rounded-md border px-2.5 text-xs", STATUS_META[stop.status]?.chip)}>{STATUS_META[stop.status]?.label ?? stop.status}</span>
        <span className="text-xs text-slate-500">
          {logged} of {saved.length} {saved.length === 1 ? "screen" : "screens"} logged · the stop is Done when every screen is, Incomplete when any is
        </span>
      </div>
      <InventoryBand stop={stop} />
      <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_420px] lg:overflow-hidden">
        <div className="space-y-5 bg-slate-50 p-5 lg:overflow-y-auto">
          <section aria-label="This visit" className="grid gap-4 rounded-xl border bg-white p-4 shadow-sm sm:grid-cols-3">
            <Field label="Date" required htmlFor="visit-date">
              <Input id="visit-date" type="date" value={who.visit_date} onChange={(e) => setWho({ ...who, visit_date: e.target.value })} />
            </Field>
            <Field label="Technician" required>
              <NameField kind="installers" aria-label="Technician" placeholder="Select or type technician name" value={who.installer} onChange={(value) => setWho({ ...who, installer: value })} />
            </Field>
            <Field label="Dolphin Manager" required>
              <NameField kind="managers" aria-label="Dolphin Manager" placeholder="Select or type manager name" value={who.dolphin_manager} onChange={(value) => setWho({ ...who, dolphin_manager: value })} />
            </Field>
          </section>

          <Section
            title="Screens"
            accent="#0ea5e9"
            action={
              <Button
                size="sm"
                variant="outline"
                disabled={adding !== null}
                onClick={() => {
                  const row = newRow();
                  setAdding(row);
                  setAddedId(null);
                  setOpen(row.key);
                }}
              >
                <Plus /> Add screen
              </Button>
            }
          >
            <ul className="divide-y divide-slate-100 border-t border-slate-100" aria-label="Screens of this store">
              {rows.map((row, index) =>
                open === row.key ? (
                  <li key={row.key} className="py-3" aria-label={`Screen ${index + 1}`}>
                    <ScreenLog
                      stop={stop}
                      project={project}
                      row={row}
                      number={index + 1}
                      planId={planId}
                      who={who}
                      onCreated={setAddedId}
                      onDone={close}
                    />
                  </li>
                ) : (
                  <li key={row.key} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 text-sm" aria-label={`Screen ${index + 1}`}>
                    <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">#{index + 1}</span>
                    <span className={cn("rounded border px-1.5 py-0.5 text-xs font-medium", STATUS_META[row.status].chip)}>{STATUS_META[row.status].label}</span>
                    <span className="min-w-0 flex-1 text-slate-700">
                      <span className="font-mono text-xs">{[row.stick_number && `Stick ${row.stick_number}`, row.venue_id].filter(Boolean).join(" · ") || "No stick or DD code yet"}</span>
                      <span className="ml-2 text-xs text-slate-500">
                        {[
                          [row.screen_size, row.screen_type].filter(Boolean).join(" ") || "no size",
                          row.is_dolphin_screen ? "Dolphin screen" : "store TV",
                          row.has_mount ? (row.has_ceiling_mount ? "ceiling mount" : "wall mount") : "no mount",
                        ].join(" · ")}
                      </span>
                    </span>
                    {outcomes.has(row.id ?? "") ? (
                      <span className={cn("rounded border px-1.5 py-0.5 text-xs font-medium", OUTCOME_TONE[outcomes.get(row.id!)!])}>{OUTCOME_LABEL[outcomes.get(row.id!)!]}</span>
                    ) : (
                      <span className="text-xs text-slate-400">Not logged</span>
                    )}
                    <Button
                      onClick={() => {
                        setAdding(null);
                        setAddedId(null);
                        setOpen(row.key);
                      }}
                      aria-label={`Log visit for screen ${index + 1}`}
                    >
                      <ClipboardCheck /> Log visit
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8"
                      aria-label={`Delete screen ${index + 1}`}
                      disabled={saved.length === 1 || update.isPending}
                      title={saved.length === 1 ? "A store needs at least one screen" : undefined}
                      onClick={() => setRemoving(row)}
                    >
                      <Trash2 />
                    </Button>
                  </li>
                ),
              )}
            </ul>
          </Section>

          <Section title="Store" accent="#0F5B7C">
            <StoreComment stop={stop} projectId={project.id} />
            <div className="border-t" />
            <UsedCounts stop={stop} projectId={project.id} />
          </Section>
        </div>
        <aside className="space-y-4 border-l bg-white p-5 lg:overflow-y-auto" aria-label="Store details">
          <StoreIdentity stop={stop} project={project} />
          <LockedGroup stop={stop} projectId={project.id} title="Store WiFi" fields={LOCKED_GROUPS.wifi} stacked />
          <VisitHistory projectId={project.id} stop={stop} />
          <div className="border-t pt-4">
            <StoreSideNotes stop={stop} project={project} />
          </div>
        </aside>
      </div>
      <ConfirmDialog open={removing !== null} title="Delete this screen?" confirmLabel="Delete screen" onConfirm={() => removing && void remove(removing)} onCancel={() => setRemoving(null)}>
        {removing ? `Screen ${removing.stick_number || removing.venue_id || "without an id"} is removed from the store now. Its log entries stay in the history.` : ""}
      </ConfirmDialog>
    </>
  );
}

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

/** One screen's log, opened from its line: what the screen is (DD code, stick, size, whose, brand, mount), then
 *  what this visit found (network, software, issue, comment) and what it left the screen as (Done or Incomplete).
 *  Save writes the screen's changes to the store and a log entry for it. */
function ScreenLog({
  stop,
  project,
  row,
  number,
  planId,
  who,
  onCreated,
  onDone,
}: {
  stop: Stop;
  project: Project;
  row: ScreenRow;
  number: number;
  planId: string;
  who: Who;
  /** A new screen got its id (it is on the store now, its log still open). */
  onCreated: (id: string) => void;
  onDone: () => void;
}) {
  const categories = useCategories();
  const update = useUpdateScreens(project.id);
  const create = useCreateVisit(project.id, stop.uid);
  const [draft, setDraft] = useState<ScreenRow>(row);
  const [log, setLog] = useState<LogDraft>(EMPTY_LOG);
  const [touched, setTouched] = useState(false);
  const venue = useVenue(draft.venue_id);
  const original = toRows(stop).find((item) => item.id !== undefined && item.id === draft.id);
  const detailsChanged = !original || !sameScreen(original, draft);
  const tree = categories.data ?? [];
  const subcategories = tree.find((entry) => entry.name === log.category)?.subcategories ?? [];
  const patch = (change: Partial<LogDraft>) => setLog((current) => ({ ...current, ...change }));

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
      if (detailsChanged) {
        const all = toRows(stop);
        const index = all.findIndex((item) => item.id !== undefined && item.id === draft.id);
        const next = index >= 0 ? all.map((item, i) => (i === index ? draft : item)) : [...all, draft];
        const savedStop = await update.mutateAsync({ uid: stop.uid, screens: toInputs(next), updatedBy: who.installer.trim() || "Route planner" });
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
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save");
    }
  };

  return (
    <div role="group" aria-label={`Log visit for screen ${number}`} className="space-y-4 rounded-xl border-2 border-brand/40 bg-white">
      {/* Stays on top while the form scrolls: what the visit left the screen as, and Save. */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-t-xl border-b bg-white px-4 py-2.5">
        <h4 className="mr-auto text-sm font-semibold text-slate-900">
          Screen {number} <span className="font-mono text-xs font-normal text-slate-500">{[draft.stick_number, draft.venue_id].filter(Boolean).join(" · ")}</span>
        </h4>
        <div role="radiogroup" aria-label={`This visit leaves screen ${number}`} className={cn("flex overflow-hidden rounded-lg border", shown("outcome") && "border-rose-400")}>
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
        <Button className="h-10 px-5" onClick={() => void save(true)} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Send />} Save log entry
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      </div>
      <div className="space-y-5 px-4 pb-4">
        {touched && Object.keys(errors).length > 0 && (
          <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
            Still needed: {Object.values(errors).join(" · ")}
          </p>
        )}

        <div role="group" aria-label="The screen" className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h5 className="text-sm font-semibold text-slate-700">The screen</h5>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-500">Status</span>
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
          </div>
          <ScreenFields row={draft} number={number} costs={project.hardware_costs} device={stop.screens.find((screen) => screen.id === draft.id)?.device} onPatch={(change) => setDraft((current) => ({ ...current, ...change }))} venueType={false} />
          {original && detailsChanged && (
            <Button size="sm" variant="outline" onClick={() => void save(false)} disabled={busy}>
              Save these details only (no log entry)
            </Button>
          )}
        </div>

        <div role="group" aria-label="Network" className="space-y-2 border-t pt-4">
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
                <div className="grid gap-4 sm:grid-cols-2">
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

        <div role="group" aria-label="Software" className="grid gap-4 border-t pt-4 sm:grid-cols-3">
          <YesNo label="Latest APK" value={log.latest_apk} onChange={(latest_apk) => patch({ latest_apk })} error={shown("latest_apk")} />
          <YesNo label="Set Kiosk Mode" value={log.kiosk_mode} onChange={(kiosk_mode) => patch({ kiosk_mode })} error={shown("kiosk_mode")} />
          <YesNo label="Dagent installed" value={log.dagent_installed} onChange={(dagent_installed) => patch({ dagent_installed })} error={shown("dagent_installed")} />
        </div>

        <div role="group" aria-label="Issue" className="space-y-4 border-t pt-4">
          <div className="grid gap-4 sm:grid-cols-2">
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
    </div>
  );
}

/** Screens and mounts used at the store: worked out from its installed screens, with a typed number over it. */
function UsedCounts({ stop, projectId }: { stop: Stop; projectId: string }) {
  const update = useUpdateStoreDetails(projectId);
  const installed = stop.screens.filter((screen) => INSTALLED_STATUSES.has(screen.status));
  const worked = { screens_used: installed.filter((screen) => screen.is_dolphin_screen).length, mounts_used: installed.filter((screen) => screen.has_mount).length };
  const [text, setText] = useState({ screens_used: stop.screens_used?.toString() ?? "", mounts_used: stop.mounts_used?.toString() ?? "" });
  const save = async (key: "screens_used" | "mounts_used") => {
    const typed = text[key].trim();
    if (typed !== "" && !/^\d+$/.test(typed)) return void toast.error("Type a whole number, or leave it blank for the worked-out one");
    const value = typed === "" ? null : Number(typed);
    if (value === (stop[key] ?? null)) return;
    try {
      await update.mutateAsync({ uid: stop.uid, body: { [key]: value } });
      toast.success(value === null ? "Back to the worked-out number" : "Saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save");
    }
  };
  const box = (key: "screens_used" | "mounts_used", label: string, hint: string) => (
    <div className="space-y-1.5">
      <Label htmlFor={`used-${key}`} className="text-sm">
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <span className="flex h-9 min-w-12 items-center justify-center rounded-md border bg-slate-50 px-3 text-sm font-semibold" aria-label={`${label}, worked out`}>
          {worked[key]}
        </span>
        <Input
          id={`used-${key}`}
          inputMode="numeric"
          placeholder="Override"
          aria-label={`${label} override`}
          className="w-28"
          value={text[key]}
          onChange={(e) => setText((current) => ({ ...current, [key]: e.target.value }))}
          onBlur={() => void save(key)}
        />
      </div>
      <p className="text-xs text-slate-500">{hint}</p>
    </div>
  );
  return (
    <div role="group" aria-label="Used at this store" className="space-y-3">
      <h4 className="text-sm font-semibold text-slate-700">Used at this store</h4>
      <div className="grid gap-4 sm:grid-cols-2">
        {box("screens_used", "Screens used", "Worked out: the installed screens that are Dolphin's. Type a number to go over it.")}
        {box("mounts_used", "Mounts used", "Worked out: the installed screens with a mount picked. Type a number to go over it.")}
      </div>
    </div>
  );
}

/** A comment on the store as a whole (each screen's own goes on its log entry). */
function StoreComment({ stop, projectId }: { stop: Stop; projectId: string }) {
  const update = useUpdateProgress(projectId);
  const [text, setText] = useState(stop.comment ?? "");
  const changed = text.trim() !== (stop.comment ?? "").trim();
  const save = async () => {
    try {
      await update.mutateAsync({ uid: stop.uid, body: { comment: text.trim() } });
      toast.success("Store comment saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the comment");
    }
  };
  return (
    <div role="group" aria-label="Comment on the store" className="space-y-2">
      <Label htmlFor="store-comment" className="text-sm font-semibold text-slate-700">
        Store comment
      </Label>
      <Textarea id="store-comment" rows={2} placeholder="Anything about the store as a whole" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void save()} disabled={!changed || update.isPending}>
          {update.isPending && <Loader2 className="animate-spin" />} Save comment
        </Button>
        <span className="text-xs text-slate-500">A screen's own comment goes on its log entry.</span>
      </div>
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
function LockedGroup({ stop, projectId, title, fields, stacked = false }: { stop: Stop; projectId: string; title: string; fields: readonly LockedField[]; /** One field per line (the narrow side panel). */ stacked?: boolean }) {
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
      <div className={cn("grid", stacked ? "gap-3" : "gap-4 sm:grid-cols-3")}>
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
                <span className="font-semibold">
                  {visit.visit_date}
                  {visit.outcome && <span className={cn("ml-1.5 rounded border px-1 py-px text-[10px] font-medium", OUTCOME_TONE[visit.outcome])}>{OUTCOME_LABEL[visit.outcome]}</span>}
                </span>
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
                {visit.kiosk_mode ? "yes" : "no"} · Dagent {visit.dagent_installed ? "yes" : "no"}
                {visit.wifi_ssid ? ` · on WiFi "${visit.wifi_ssid}"` : ""}
              </div>
              {visit.comments && <p className="mt-1 whitespace-pre-wrap text-slate-700">{visit.comments}</p>}
            </li>
          ))}
        </ol>
      )}
    </Wrapper>
  );
}
