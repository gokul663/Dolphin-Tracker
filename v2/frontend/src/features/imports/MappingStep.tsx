import { Loader2, Lock } from "lucide-react";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
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

// Radix Select cannot hold "" as a value; the "Other imported data" target travels as this token in the UI.
const OTHER_TOKEN = "__other__";
const toUi = (target: string) => (target === "" ? OTHER_TOKEN : target);
const fromUi = (value: string) => (value === OTHER_TOKEN ? "" : value);

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
                      <Select value={toUi(target)} disabled={pending} onValueChange={(value) => onRepoint(column, fromUi(value))}>
                        <SelectTrigger aria-label={`Field for column ${column}`} className="h-8 w-64">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="max-h-80">
                          {groups.map((group) => (
                            <SelectGroup key={group.label}>
                              <SelectLabel>{group.label}</SelectLabel>
                              {group.options.map((option) => {
                                const owner = takenBy(mapping, option.value, column);
                                const unavailable = isLocked(option.value) || owner !== null;
                                return (
                                  <SelectItem key={option.value || OTHER_TOKEN} value={toUi(option.value)} disabled={unavailable}>
                                    {option.label}
                                    {owner && <span className="text-[10px] text-slate-400"> (from {owner})</span>}
                                  </SelectItem>
                                );
                              })}
                            </SelectGroup>
                          ))}
                        </SelectContent>
                      </Select>
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
