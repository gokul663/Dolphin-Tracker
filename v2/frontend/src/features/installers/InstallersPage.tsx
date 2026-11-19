import { useState } from "react";
import { AlertTriangle, Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { nameKey } from "@/features/installers/InstallerName";
import { useInstallers, useInstallerWork, useRemoveName, useSaveInstaller, useSyncInstallers } from "@/features/lists/api";
import { ApiError, type NameEntry } from "@/lib/api/types";

/** Every installer, for all projects: who they are and how to reach them. The same names are what the technician,
 *  visit and route plan fields suggest; one that was only typed there shows here without details until they are
 *  filled in. */
export function InstallersPage() {
  const installers = useInstallers();
  const remove = useRemoveName("installers");
  const work = useInstallerWork();
  const sync = useSyncInstallers();
  const workOf = new Map((work.data?.installers ?? []).map((item) => [nameKey(item.name), item]));
  const toSync = (work.data?.installers ?? []).reduce((sum, item) => sum + item.to_sync, 0);
  const unlisted = work.data?.unlisted ?? [];
  const onSync = () =>
    sync.mutate(undefined, {
      onSuccess: (result) => toast.success(result.stores_updated ? `${result.stores_updated} store records now use the Installers list's spelling` : "Every matching record already uses the list's spelling"),
      onError: (error) => toast.error(error instanceof Error ? error.message : "Could not sync"),
    });
  const count = (value: number | undefined) => (value === undefined ? <span className="text-slate-300">…</span> : value.toLocaleString());
  const [editing, setEditing] = useState<NameEntry | "new" | { add: string } | null>(null);
  const [removing, setRemoving] = useState<NameEntry | null>(null);
  const items = installers.data ?? [];
  const noPhone = items.filter((item) => !item.phone).length;
  const head = "px-3 py-2 text-left font-mono text-[11px] font-normal uppercase tracking-wider text-slate-500";
  return (
    <section className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-mono text-xs uppercase tracking-[3px] text-slate-500">Installers</h1>
          <p className="mt-1 text-sm text-slate-600">
            {items.length} {items.length === 1 ? "installer" : "installers"}, shared by every project
            {noPhone > 0 && (
              <span className="ml-2 inline-flex items-center gap-1 text-amber-700">
                <AlertTriangle size={13} /> {noPhone} without a phone number
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Records typed as "carlos" for the installer "Carlos": the same person, brought to the list's spelling. */}
          <Button variant="outline" onClick={onSync} disabled={sync.isPending || toSync === 0} title={toSync === 0 ? "No store record differs from the list's spelling" : "Store records that match an installer in another case take the list's spelling"}>
            {sync.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Sync names{toSync > 0 ? ` (${toSync})` : ""}
          </Button>
          <Button onClick={() => setEditing("new")}>
            <Plus /> Add installer
          </Button>
        </div>
      </div>
      <Card className="overflow-hidden p-0">
        {installers.isPending ? (
          <p className="p-8 text-center font-mono text-sm text-slate-500">Loading installers…</p>
        ) : installers.isError ? (
          <p className="p-8 text-center text-sm text-rose-700">Could not load installers: {installers.error.message}</p>
        ) : items.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-500">No installers yet. Add the first one.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Installers">
              <thead className="border-b bg-slate-50">
                <tr>
                  <th className={head}>Name</th>
                  <th className={head}>Phone</th>
                  <th className={head}>Email</th>
                  <th className={head}>Current shipping address</th>
                  <th className={`${head} text-right`}>Stores</th>
                  <th className={`${head} text-right`}>Screens done</th>
                  <th className={`${head} text-right`}>Upcoming</th>
                  <th className={head} />
                </tr>
              </thead>
              <tbody className="divide-y">
                {items.map((item) => (
                  <tr key={item.value} aria-label={item.value}>
                    <td className="px-3 py-2.5 font-medium text-slate-900">{item.value}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      {item.phone ? (
                        <a href={`tel:${item.phone}`} className="block font-mono text-xs text-slate-800 hover:text-brand hover:underline">
                          {item.phone}
                        </a>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
                          <AlertTriangle size={12} /> No phone
                        </span>
                      )}
                      {item.phone2 && (
                        <a href={`tel:${item.phone2}`} className="mt-0.5 block font-mono text-xs text-slate-500 hover:text-brand hover:underline">
                          {item.phone2}
                        </a>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {item.email ? (
                        <a href={`mailto:${item.email}`} className="block text-slate-800 hover:text-brand hover:underline">
                          {item.email}
                        </a>
                      ) : (
                        !item.email2 && <span className="text-slate-300">—</span>
                      )}
                      {item.email2 && (
                        <a href={`mailto:${item.email2}`} className="mt-0.5 block text-xs text-slate-500 hover:text-brand hover:underline">
                          {item.email2}
                        </a>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-slate-700">{item.shipping_address || <span className="text-slate-300">—</span>}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">{count(work.data ? (workOf.get(nameKey(item.value))?.stores ?? 0) : undefined)}</td>
                    <td className="px-3 py-2.5 text-right font-mono font-semibold tabular-nums text-green-700">
                      {count(work.data ? (workOf.get(nameKey(item.value))?.screens_done ?? 0) : undefined)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-600">
                      {count(work.data ? (workOf.get(nameKey(item.value))?.screens_upcoming ?? 0) : undefined)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right">
                      <Button size="icon" variant="ghost" className="size-8" aria-label={`Edit ${item.value}`} onClick={() => setEditing(item)}>
                        <Pencil />
                      </Button>
                      <Button size="icon" variant="ghost" className="size-8" aria-label={`Remove ${item.value}`} onClick={() => setRemoving(item)}>
                        <Trash2 />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {unlisted.length > 0 && (
        <Card className="gap-3 p-4" aria-label="Names not in the list">
          <div>
            <h2 className="flex items-center gap-1.5 text-sm font-medium text-slate-900">
              <AlertTriangle size={14} className="text-amber-600" /> On stores, but not in the Installers list ({unlisted.length})
            </h2>
            <p className="text-xs text-slate-500">These names are on store records and match no installer above. The records are kept; add the installer to tie them together.</p>
          </div>
          <ul className="divide-y">
            {unlisted.map((item) => (
              <li key={item.name} className="flex flex-wrap items-center gap-3 py-2 text-sm" aria-label={item.name}>
                <span className="min-w-0 flex-1 truncate font-medium text-slate-900">{item.name}</span>
                <span className="font-mono text-xs text-slate-600">
                  {item.stores} {item.stores === 1 ? "store" : "stores"} · {item.screens_done} done · {item.screens_upcoming} upcoming
                </span>
                <Button size="sm" variant="outline" aria-label={`Add ${item.name} as an installer`} onClick={() => setEditing({ add: item.name })}>
                  <Plus /> Add
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {editing && (
        <InstallerDialog
          key={editing === "new" ? "new" : "add" in editing ? `add-${editing.add}` : editing.value}
          installer={editing === "new" || "add" in editing ? null : editing}
          suggestedName={editing !== "new" && "add" in editing ? editing.add : ""}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.value ?? "this installer"}?`}
        confirmLabel="Remove installer"
        busy={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() =>
          removing &&
          remove.mutate(removing.value, {
            onSuccess: () => setRemoving(null),
            onError: (error) => toast.error(error instanceof Error ? error.message : "Could not remove"),
          })
        }
      >
        Their phone, email and shipping address are deleted and the name is no longer suggested. Stores, visits and route plans that already name them keep
        the name.
      </ConfirmDialog>
    </section>
  );
}

/** Add an installer, or change one's details, the name included. A name and a phone number are needed; ticking "no
 *  phone number yet" saves without one, and the installer is flagged until it is added. Renaming carries the store
 *  records and active route plans that name the installer; closed plans and logged visits keep the old name. */
function InstallerDialog({ installer, suggestedName = "", onClose }: { installer: NameEntry | null; suggestedName?: string; onClose: () => void }) {
  const [form, setForm] = useState({
    name: installer?.value ?? suggestedName,
    phone: installer?.phone ?? "",
    phone2: installer?.phone2 ?? "",
    email: installer?.email ?? "",
    email2: installer?.email2 ?? "",
    shipping_address: installer?.shipping_address ?? "",
  });
  // An installer already saved without a phone stays that way until a number is typed.
  const [noPhone, setNoPhone] = useState(installer !== null && !installer.phone);
  // The additional phone and email show once asked for (or when the installer already has one).
  const [more, setMore] = useState({ phone2: Boolean(installer?.phone2), email2: Boolean(installer?.email2) });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useSaveInstaller();
  const set = (key: keyof typeof form, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors(({ [key]: _fixed, ...rest }) => rest);
  };
  const submit = () => {
    const name = form.name.trim();
    const phone = form.phone.trim(); // a number typed wins over the "no phone yet" tick
    const missing: Record<string, string> = {};
    if (!name) missing.name = "A name is required";
    if (!phone && !noPhone) missing.phone = "A phone number is required, or tick the box below to add them without one";
    if (Object.keys(missing).length) return setErrors(missing);
    const renamed = installer !== null && name !== installer.value;
    save.mutate(
      {
        name: installer?.value ?? name,
        body: {
          phone,
          phone2: more.phone2 ? form.phone2.trim() : "",
          email: form.email.trim(),
          email2: more.email2 ? form.email2.trim() : "",
          shipping_address: form.shipping_address.trim(),
          allow_no_phone: noPhone && !phone,
          must_be_new: installer === null,
          ...(renamed ? { new_name: name } : {}),
        },
      },
      {
        onSuccess: (saved) => {
          const carried = [
            saved.stores_renamed ? `${saved.stores_renamed} store ${saved.stores_renamed === 1 ? "record" : "records"}` : "",
            saved.plans_renamed ? `${saved.plans_renamed} route ${saved.plans_renamed === 1 ? "plan" : "plans"}` : "",
          ].filter(Boolean);
          toast.success(
            renamed ? `${installer.value} is now ${saved.value}` : saved.phone ? `${saved.value} saved` : `${saved.value} saved without a phone number`,
            renamed && carried.length ? { description: `${carried.join(" and ")} now use the new name` } : undefined,
          );
          onClose();
        },
        onError: (error) => {
          const detail = error instanceof ApiError ? error.validation : null;
          if (detail?.fields) setErrors(detail.fields);
          else toast.error(error instanceof Error ? error.message : "Could not save");
        },
      },
    );
  };
  const field = (key: keyof typeof form, label: string, props: React.ComponentProps<typeof Input> = {}) => (
    <div className="space-y-1.5">
      <Label htmlFor={`installer-${key}`}>{label}</Label>
      <Input id={`installer-${key}`} value={form[key]} aria-invalid={Boolean(errors[key])} onChange={(event) => set(key, event.target.value)} {...props} />
      {errors[key] && (
        <p className="text-xs text-rose-600" role="alert">
          {errors[key]}
        </p>
      )}
    </div>
  );
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{installer ? `Edit ${installer.value}` : "Add an installer"}</DialogTitle>
          <DialogDescription>Installers are shared by every project. A name and a phone number are needed.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {field("name", "Full name *", { autoFocus: installer === null, placeholder: "First and last name" })}
          {installer && form.name.trim() !== installer.value && form.name.trim() !== "" && (
            <p className="-mt-1 text-xs text-slate-500">
              Store records and active route plans that say {installer.value} will say {form.name.trim()}. Closed plans and logged visits keep the old name.
            </p>
          )}
          {field("phone", "Phone number *", { type: "tel", inputMode: "tel", placeholder: "e.g. (555) 010-2000", autoFocus: installer !== null })}
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <Checkbox
              checked={noPhone}
              onCheckedChange={(checked) => {
                setNoPhone(checked === true);
                setErrors(({ phone: _fixed, ...rest }) => rest);
              }}
            />
            No phone number yet (the installer is flagged until one is added)
          </label>
          {more.phone2 ? (
            field("phone2", "Additional phone number", { type: "tel", inputMode: "tel", placeholder: "e.g. (555) 010-3000" })
          ) : (
            <Button type="button" variant="ghost" size="sm" className="-ml-2 h-7 text-brand" onClick={() => setMore((current) => ({ ...current, phone2: true }))}>
              <Plus /> Add another phone number
            </Button>
          )}
          {field("email", "Email", { type: "email", placeholder: "name@example.com" })}
          {more.email2 ? (
            field("email2", "Additional email", { type: "email", placeholder: "name@example.com" })
          ) : (
            <Button type="button" variant="ghost" size="sm" className="-ml-2 h-7 text-brand" onClick={() => setMore((current) => ({ ...current, email2: true }))}>
              <Plus /> Add another email
            </Button>
          )}
          {field("shipping_address", "Current shipping address", { placeholder: "Where hardware is shipped to them" })}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />} {installer ? "Save installer" : "Add installer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
