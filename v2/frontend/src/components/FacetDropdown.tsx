import { useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface FacetOption {
  value: string;
  label: string;
  count?: number;
  /** A colour dot before the label (a status). */
  dot?: string;
}

interface Props {
  /** What the filter is called: "State". The button reads "State", "State: Georgia" or "State (2)". */
  label: string;
  options: FacetOption[];
  selected: string[];
  onToggle: (value: string) => void;
  /** A search box above the values (on by default). */
  searchable?: boolean;
}

/** One multi-select filter with the look of the Projects page's filters: an outline button that is tinted while
 *  something is picked, and a menu of values with counts and a search box. */
export function FacetDropdown({ label, options, selected, onToggle, searchable = true }: Props) {
  const [query, setQuery] = useState("");
  const labelOf = (value: string) => options.find((option) => option.value === value)?.label ?? value;
  const summary = selected.length === 0 ? label : selected.length === 1 ? `${label}: ${labelOf(selected[0]!)}` : `${label} (${selected.length})`;
  // A picked value stays listed (to untick it) even when the other filters leave it no store.
  const all: FacetOption[] = [...options, ...selected.filter((value) => !options.some((option) => option.value === value)).map((value) => ({ value, label: value, count: 0 }))];
  const disabled = all.length === 0;
  const needle = query.trim().toLowerCase();
  const shown = needle ? all.filter((option) => option.label.toLowerCase().includes(needle)) : all;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          variant="outline"
          size="sm"
          aria-label={disabled ? `${summary} (no values)` : summary}
          className={cn("max-w-52 font-mono text-xs", selected.length > 0 && "border-brand/40 bg-brand/10 text-brand hover:bg-brand/15 hover:text-brand disabled:opacity-100")}
        >
          <span className="truncate">{summary}</span>
          {disabled ? <span className="text-[11px] text-slate-400">no values</span> : <ChevronDown />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 p-0" onCloseAutoFocus={() => setQuery("")}>
        {searchable && (
          <div className="relative border-b p-1.5">
            <Search size={13} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              autoFocus
              aria-label={`Search ${label}`}
              placeholder="Search…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              // Keep typing in the box: the menu would otherwise jump to items by letter and steal focus.
              onKeyDown={(event) => event.key !== "Escape" && event.stopPropagation()}
              className="h-7 w-full rounded-md border bg-white pl-7 pr-2 text-sm outline-none focus:border-slate-400"
            />
          </div>
        )}
        <div className="max-h-72 overflow-y-auto p-1">
          {shown.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-slate-400">No match</p>
          ) : (
            shown.map((option) => (
              <DropdownMenuCheckboxItem key={option.value || "(blank)"} checked={selected.includes(option.value)} onCheckedChange={() => onToggle(option.value)} onSelect={(event) => event.preventDefault()}>
                {option.dot && <span className="size-2 rounded-full" style={{ background: option.dot }} />}
                <span className="flex-1">{option.label}</span>
                {option.count !== undefined && <span className="font-mono text-xs text-slate-400">{option.count}</span>}
              </DropdownMenuCheckboxItem>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
