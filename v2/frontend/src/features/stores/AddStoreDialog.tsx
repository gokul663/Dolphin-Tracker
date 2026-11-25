import { useState } from "react";
import { Loader2, MapPin } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAddStore } from "@/features/stores/api";
import { ApiError, type Project, type StoreAdd } from "@/lib/api/types";

const EMPTY: StoreAdd = { external_id: "", store_name: "", addr: "", city: "", state: "", zip: "" };
const REQUIRED: [keyof StoreAdd, string][] = [["external_id", "ExtID is required"], ["store_name", "Store name is required"], ["addr", "Address is required"]];

/** Add one store by hand. It gets the checks a sheet row gets: ExtID, store name and address are required, the ExtID
 *  and the address must be new to the project, and Google must verify the address (or one of its suggestions is
 *  picked). Everything else about the store is filled in its window, which opens once it is added. */
export function AddStoreDialog({ project, open, onClose, onAdded }: { project: Project; open: boolean; onClose: () => void; onAdded?: (uid: string) => void }) {
  const [form, setForm] = useState<StoreAdd>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [address, setAddress] = useState<{ message: string; suggestions: string[] } | null>(null);
  const add = useAddStore(project.id);
  const close = () => {
    setForm(EMPTY);
    setErrors({});
    setAddress(null);
    onClose();
  };
  const set = (key: keyof StoreAdd, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors(({ [key]: _fixed, ...rest }) => rest);
    if (key !== "external_id" && key !== "store_name") setAddress(null);
  };
  const submit = (body: StoreAdd) => {
    const missing = Object.fromEntries(REQUIRED.filter(([key]) => !(body[key] ?? "").trim()));
    if (Object.keys(missing).length) return setErrors(missing);
    add.mutate(body, {
      onSuccess: (stop) => {
        toast.success(`${stop.store_name} added`);
        close();
        onAdded?.(stop.uid);
      },
      onError: (error) => {
        const detail = error instanceof ApiError ? error.validation : null;
        if (detail?.fields) setErrors(detail.fields);
        else if (detail?.suggestions !== undefined) setAddress({ message: detail.message, suggestions: detail.suggestions ?? [] });
        else toast.error(error instanceof Error ? error.message : "Could not add the store");
      },
    });
  };
  /** A suggestion is a whole address line: sent as the address alone, and the server splits it. */
  const pickSuggestion = (suggestion: string) => {
    const body = { ...form, addr: suggestion, city: "", state: "", zip: "" };
    setForm(body);
    setAddress(null);
    submit(body);
  };
  const field = (key: keyof StoreAdd, label: string, props: React.ComponentProps<typeof Input> = {}) => (
    <div className="space-y-1.5">
      <Label htmlFor={`add-store-${key}`}>{label}</Label>
      <Input id={`add-store-${key}`} value={form[key] ?? ""} aria-invalid={Boolean(errors[key])} onChange={(event) => set(key, event.target.value)} {...props} />
      {errors[key] && (
        <p className="text-xs text-rose-600" role="alert">
          {errors[key]}
        </p>
      )}
    </div>
  );
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a store</DialogTitle>
          <DialogDescription>
            Checked like a row of a sheet: the ExtID and the address must be new to {project.name}, and Google verifies the address.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit(form);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
            {field("external_id", "ExtID *", { placeholder: "e.g. TX15895", autoFocus: true })}
            {field("store_name", "Store name *")}
          </div>
          {field("addr", "Address *", { placeholder: "Street address" })}
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_5rem_7rem]">
            {field("city", "City")}
            {field("state", "State", { placeholder: "TX" })}
            {field("zip", "ZIP")}
          </div>
          {address && (
            <div className="space-y-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
              <p>{address.message}</p>
              {address.suggestions.length > 0 && (
                <ul className="space-y-1" aria-label="Address suggestions">
                  {address.suggestions.map((suggestion) => (
                    <li key={suggestion}>
                      <button type="button" className="flex w-full items-center gap-1.5 rounded-md bg-white px-2 py-1.5 text-left text-slate-800 shadow-xs hover:bg-slate-50" onClick={() => pickSuggestion(suggestion)}>
                        <MapPin size={13} className="shrink-0 text-slate-400" /> {suggestion}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={add.isPending}>
              {add.isPending && <Loader2 className="animate-spin" />} Add store
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
