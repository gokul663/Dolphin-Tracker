import { useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface Props {
  value: string;
  label: string;
  /** Returns an error message to keep editing, or null when the value may be saved. */
  validate: (value: string) => string | null;
  onSave: (value: string) => Promise<unknown>;
}

/** Click to edit; Enter or blur saves, Escape cancels. Invalid values stay in the editor with the message. */
export function EditableCell({ value, label, validate, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const commit = async () => {
    if (saving) return; // Enter then blur would otherwise send the PATCH twice
    const next = draft.trim();
    if (next === value.trim()) return setEditing(false);
    const problem = validate(next);
    if (problem) return setError(problem);
    setSaving(true);
    try {
      await onSave(next);
      setEditing(false);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        className="block w-full truncate rounded px-1 py-0.5 text-left hover:bg-slate-100 focus-visible:outline-2"
        title={value ? `${value} (click to edit)` : "Click to edit"}
        aria-label={`Edit ${label}`}
        onClick={(event) => {
          event.stopPropagation();
          setDraft(value);
          setError(null);
          setEditing(true);
        }}
      >
        {value || <span className="text-slate-300">—</span>}
      </button>
    );
  }
  return (
    <div onClick={(event) => event.stopPropagation()}>
      <Input
        autoFocus
        aria-label={label}
        aria-invalid={Boolean(error)}
        value={draft}
        disabled={saving}
        className={cn("h-7 px-1.5 text-sm", error && "border-rose-400")}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") void commit();
          if (event.key === "Escape") {
            setEditing(false);
            setError(null);
          }
        }}
      />
      {error && <p className="mt-0.5 whitespace-normal text-[11px] leading-tight text-rose-600">{error}</p>}
    </div>
  );
}
