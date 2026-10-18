import { Check, Minus, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  id?: string;
  label: string;
  value: boolean | null;
  onChange: (value: boolean | null) => void;
  disabled?: boolean;
}

const NEXT: Record<string, boolean | null> = { null: true, true: false, false: null };
const TEXT: Record<string, string> = { null: "Unknown", true: "Yes", false: "No" };

/** Yes / No / Unknown (STORE-MODEL §2 tri-state checks). Clicking cycles Unknown → Yes → No → Unknown. */
export function TriStateCheckbox({ id, label, value, onChange, disabled }: Props) {
  const key = String(value);
  return (
    <button
      id={id}
      type="button"
      role="checkbox"
      aria-checked={value === null ? "mixed" : value}
      aria-label={`${label}: ${TEXT[key]}`}
      disabled={disabled}
      onClick={() => onChange(NEXT[key] ?? null)}
      className="flex items-center gap-2 rounded-md px-1 py-0.5 text-left text-sm hover:bg-slate-50 disabled:opacity-50"
    >
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded border",
          value === true && "border-emerald-600 bg-emerald-600 text-white",
          value === false && "border-rose-500 bg-rose-50 text-rose-600",
          value === null && "border-slate-300 text-slate-400",
        )}
      >
        {value === true ? <Check size={12} /> : value === false ? <X size={12} /> : <Minus size={12} />}
      </span>
      <span>{label}</span>
      <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-slate-500">{TEXT[key]}</span>
    </button>
  );
}
