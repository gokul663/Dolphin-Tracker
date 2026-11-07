import { useState } from "react";
import { Check, ChevronDown, Loader2, Lock, Search } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isLocked, sampleValues, takenBy, targetGroups, targetLabel } from "@/features/imports/model";
import type { ImportResult, StoreFieldSpec } from "@/lib/api/types";

interface Props {
  result: ImportResult;
  specs: StoreFieldSpec[];
  /** Re-point one column; the server re-maps the sheet (no new geocoding) and returns the new result. */
  onRepoint: (column: string, target: string) => void;
  pending: boolean;
  error: string | null;
}


/** The detected STORE-MODEL §6 mapping, one row per sheet column, each with a re-point control. */
export function MappingStep({ result, specs, onRepoint, pending, error }: Props) {
  const mapping = result.mapping;
  const groups = targetGroups(specs);
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Each column of the sheet and the store field it fills. Change a field to re-point the column; the rows are rebuilt
        without checking the addresses again. The mapping is saved on the project for its next sheet.
        {pending && <Loader2 className="ml-2 inline size-4 animate-spin" aria-label="Re-mapping" />}
      </p>
      {error && (
        <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </p>
      )}
      <div className="max-h-[50vh] overflow-auto rounded-lg border">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            <tr className="text-left">
              <th className="p-2">Sheet column</th>
              <th className="p-2">Store field</th>
              <th className="p-2">Example values</th>
            </tr>
          </thead>
          <tbody>
            {result.columns.map((column) => {
              const target = mapping[column] ?? "";
              const locked = isLocked(target);
              return (
                <tr key={column} className="border-t align-top">
                  <td className="p-2 font-mono text-xs">{column}</td>
                  <td className="p-2">
                    {locked ? (
                      <span className="inline-flex items-center gap-1 text-xs text-slate-600" title="Re-upload the sheet to change the address columns">
                        <Lock size={12} /> {targetLabel(specs, target)}
                      </span>
                    ) : (
                      <FieldPicker
                        column={column}
                        value={target}
                        groups={groups}
                        disabled={pending}
                        label={targetLabel(specs, target)}
                        ownerOf={(value) => takenBy(mapping, value, column)}
                        onPick={(value) => onRepoint(column, value)}
                      />
                    )}
                  </td>
                  <td className="p-2 text-xs text-slate-500">
                    <p className="line-clamp-2 [overflow-wrap:anywhere]">{sampleValues(result, column, target).join(" · ") || "—"}</p>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type Groups = ReturnType<typeof targetGroups>;

/** The store field for one sheet column: a menu of every field by group, with a search box on top. */
function FieldPicker({
  column,
  value,
  groups,
  disabled,
  label,
  ownerOf,
  onPick,
}: {
  column: string;
  value: string;
  groups: Groups;
  disabled: boolean;
  label: string;
  ownerOf: (value: string) => string | null;
  onPick: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = groups
    .map((group) => ({
      ...group,
      options: group.options.filter((option) => !needle || `${option.label} ${option.value}`.toLowerCase().includes(needle)),
    }))
    .filter((group) => group.options.length > 0);
  return (
    <DropdownMenu onOpenChange={(open) => !open && setQuery("")}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          role="combobox"
          aria-label={`Field for column ${column}`}
          className="flex h-8 w-64 items-center justify-between gap-2 rounded-md border bg-white px-3 text-left text-sm shadow-xs hover:bg-slate-50 disabled:opacity-50"
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80 p-0">
        <div className="relative border-b p-1.5">
          <Search size={13} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            autoFocus
            aria-label={`Search fields for column ${column}`}
            placeholder="Search fields…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key !== "Escape" && event.stopPropagation()} // keep typing in the box
            className="h-7 w-full rounded-md border bg-white pl-7 pr-2 text-sm outline-none focus:border-slate-400"
          />
        </div>
        <div className="max-h-80 overflow-y-auto p-1">
          {shown.length === 0 && <p className="px-2 py-3 text-center text-xs text-slate-400">No field matches</p>}
          {shown.map((group) => (
            <div key={group.label} role="group" aria-label={group.label}>
              <DropdownMenuLabel className="text-xs font-normal text-slate-500">{group.label}</DropdownMenuLabel>
              {group.options.map((option) => {
                const owner = ownerOf(option.value);
                const unavailable = isLocked(option.value) || owner !== null;
                return (
                  <DropdownMenuItem
                    key={option.value || "(other)"}
                    role="option"
                    aria-selected={option.value === value}
                    disabled={unavailable}
                    onSelect={() => option.value !== value && onPick(option.value)}
                  >
                    <span className="flex-1">
                      {option.label}
                      {owner && <span className="text-[10px] text-slate-400"> (from {owner})</span>}
                    </span>
                    {option.value === value && <Check className="size-4" />}
                  </DropdownMenuItem>
                );
              })}
            </div>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
