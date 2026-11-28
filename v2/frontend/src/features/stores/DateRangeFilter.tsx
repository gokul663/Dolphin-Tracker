import { useId, useState } from "react";
import { CalendarDays, ChevronDown } from "lucide-react";
import { Segmented } from "@/components/Segmented";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RANGE_LABELS, rangeText } from "@/features/stores/filters";
import { cn } from "@/lib/utils";
import { isRelative, NO_RANGE, rangeActive, useStoresUi, type DateRange, type DateRangeFilter, type RelativeRange } from "@/stores/ui";

/** One click each; "Today" is the last 1 day. */
export const DATE_PRESETS: { text: string; range: RelativeRange }[] = [
  { text: "Today", range: { kind: "last", n: 1, unit: "days" } },
  { text: "Last 2 Days", range: { kind: "last", n: 2, unit: "days" } },
  { text: "Last 7 Days", range: { kind: "last", n: 7, unit: "days" } },
  { text: "Last 30 Days", range: { kind: "last", n: 30, unit: "days" } },
];
const MAX_LAST = 9999;

const samePreset = (range: DateRange, preset: RelativeRange) => isRelative(range) && range.n === preset.n && range.unit === preset.unit;

/** A registration-date filter: a button that reads the current choice ("Last 7 Days", "2026-01-01 – 2026-03-31", or
 *  the filter's name when off), opening presets, "Last N days / weeks", a custom start–end and Clear. Every choice
 *  applies at once; a custom range only once its start is not after its end. */
export function DateRangeFilter({ name, wide = false }: { name: DateRangeFilter; wide?: boolean }) {
  const range = useStoresUi((state) => state.ranges[name]);
  const setRange = useStoresUi((state) => state.setRange);
  const [open, setOpen] = useState(false);
  const label = RANGE_LABELS[name];
  const active = rangeActive(range);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={active ? `${label}: ${rangeText(range)}` : label}
          className={cn(
            "font-mono text-xs",
            wide ? "h-9 w-full justify-start" : "max-w-64",
            active && "border-brand/40 bg-brand/10 text-brand hover:bg-brand/15 hover:text-brand",
          )}
        >
          <CalendarDays />
          <span className="truncate">{active ? (wide ? rangeText(range) : `${label}: ${rangeText(range)}`) : wide ? "Any date" : label}</span>
          <ChevronDown className={cn(wide && "ml-auto")} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="glass w-[21rem] rounded-2xl p-0">
        <DatePanel key={open ? "open" : "closed"} label={label} range={range} onChange={(next) => setRange(name, next)} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

function DatePanel({ label, range, onChange, onDone }: { label: string; range: DateRange; onChange: (range: DateRange) => void; onDone: () => void }) {
  const id = useId();
  const [count, setCount] = useState(isRelative(range) ? String(range.n) : "");
  const [unit, setUnit] = useState<RelativeRange["unit"]>(isRelative(range) ? range.unit : "days");
  const [from, setFrom] = useState(isRelative(range) ? "" : range.from);
  const [to, setTo] = useState(isRelative(range) ? "" : range.to);
  const backwards = Boolean(from && to && from > to);
  const lastN = (text: string, nextUnit: RelativeRange["unit"]) => {
    const digits = text.replace(/\D/g, "").slice(0, 4);
    setCount(digits);
    setUnit(nextUnit);
    const n = Number(digits);
    if (n >= 1 && n <= MAX_LAST) {
      setFrom("");
      setTo("");
      onChange({ kind: "last", n, unit: nextUnit });
    }
  };
  const custom = (nextFrom: string, nextTo: string) => {
    setFrom(nextFrom);
    setTo(nextTo);
    setCount("");
    if (!(nextFrom && nextTo && nextFrom > nextTo)) onChange({ from: nextFrom, to: nextTo });
  };
  return (
    <div role="group" aria-label={label} className="divide-y divide-slate-900/[0.07]">
      <div className="flex items-baseline justify-between gap-2 px-4 pt-3.5 pb-3">
        <p className="font-display text-lg leading-none tracking-[1.5px] text-slate-900">{label}</p>
        <p className="font-mono text-[11px] text-slate-600" aria-live="polite">
          {rangeActive(range) ? rangeText(range) : "Off"}
        </p>
      </div>

      <section aria-labelledby={`${id}-quick`} className="space-y-2 px-4 py-3">
        <h4 id={`${id}-quick`} className="font-mono text-[10px] tracking-wider text-slate-600 uppercase">
          Quick Pick
        </h4>
        <div className="grid grid-cols-2 gap-1.5">
          {DATE_PRESETS.map((preset) => {
            const on = samePreset(range, preset.range);
            return (
              <button
                key={preset.text}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  setCount(String(preset.range.n));
                  setUnit(preset.range.unit);
                  setFrom("");
                  setTo("");
                  onChange(preset.range);
                }}
                className={cn(
                  "h-9 rounded-lg px-3 text-left text-sm font-medium ring-1 transition-colors outline-none ring-inset focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                  on ? "bg-brand text-white ring-brand hover:bg-brand-strong" : "bg-white/70 text-slate-800 ring-slate-200 hover:bg-white hover:ring-slate-300",
                )}
              >
                {preset.text}
              </button>
            );
          })}
        </div>
      </section>

      <section aria-labelledby={`${id}-last`} className="space-y-2 px-4 py-3">
        <h4 id={`${id}-last`} className="font-mono text-[10px] tracking-wider text-slate-600 uppercase">
          Last N
        </h4>
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-700">Last</span>
          <Input
            inputMode="numeric"
            aria-label={`${label}: number of days or weeks`}
            placeholder="N"
            value={count}
            onChange={(event) => lastN(event.target.value, unit)}
            className="h-9 w-16 bg-white text-center tabular-nums"
          />
          <Segmented
            label={`${label}: unit`}
            options={[{ value: "days", text: "Days" }, { value: "weeks", text: "Weeks" }]}
            value={unit}
            onChange={(next) => lastN(count, next)}
          />
        </div>
      </section>

      <section aria-labelledby={`${id}-custom`} className="space-y-2 px-4 py-3">
        <h4 id={`${id}-custom`} className="font-mono text-[10px] tracking-wider text-slate-600 uppercase">
          Custom Range
        </h4>
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="block text-xs font-medium text-slate-700">Start</span>
            <Input type="date" aria-label={`${label} start`} aria-invalid={backwards} value={from} max={to || undefined} onChange={(event) => custom(event.target.value, to)} className="h-9 bg-white text-sm" />
          </label>
          <label className="space-y-1">
            <span className="block text-xs font-medium text-slate-700">End</span>
            <Input type="date" aria-label={`${label} end`} aria-invalid={backwards} value={to} min={from || undefined} onChange={(event) => custom(from, event.target.value)} className="h-9 bg-white text-sm" />
          </label>
        </div>
        {backwards ? (
          <p role="alert" className="text-xs font-medium text-rose-700">
            The start date is after the end date. Pick an earlier start or a later end.
          </p>
        ) : (
          <p className="text-xs text-slate-600">Either end may stay empty.</p>
        )}
      </section>

      <div className="flex items-center justify-between gap-2 px-4 py-2.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-9"
          disabled={!rangeActive(range)}
          onClick={() => {
            onChange(NO_RANGE);
            onDone();
          }}
        >
          Clear
        </Button>
        <Button type="button" size="sm" className="h-9 px-4" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
