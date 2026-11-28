import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T> {
  value: T;
  /** What the button shows (a symbol, "10 mi"). */
  text: ReactNode;
  /** The full name for screen readers and the tooltip, when `text` is a symbol. */
  name?: string;
}

/** A row of mutually exclusive choices as `aria-pressed` buttons in one group: the chosen one solid brand with white
 *  text (7.5:1), the others quiet dark text on the track (9:1). The group is named by `label` or `labelledBy`. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
  labelledBy,
  className,
}: {
  options: readonly SegmentedOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  label?: string;
  labelledBy?: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      className={cn("inline-flex shrink-0 gap-0.5 rounded-lg bg-slate-100 p-0.5 ring-1 ring-slate-200 ring-inset", className)}
    >
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={on}
            aria-label={option.name}
            title={option.name}
            onClick={() => onChange(option.value)}
            className={cn(
              "h-9 min-w-9 rounded-md px-2.5 text-xs font-semibold tabular-nums transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 motion-reduce:transition-none",
              on ? "bg-brand text-white shadow-sm hover:bg-brand-strong" : "text-slate-700 hover:bg-white hover:text-slate-950",
            )}
          >
            {option.text}
          </button>
        );
      })}
    </div>
  );
}
