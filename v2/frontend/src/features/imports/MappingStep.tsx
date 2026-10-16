import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { newFieldTarget, type ColumnMapping, type ColumnTarget, type ReviewRow } from "@/features/imports/model";
import type { FieldDef } from "@/lib/api/types";

interface Props {
  columns: string[];
  rows: ReviewRow[];
  schema: FieldDef[];
  mapping: ColumnMapping;
  onMappingChange: (mapping: ColumnMapping) => void;
  errors: string[];
  problems: { index: number; key: string; message: string }[];
  dropInvalid: boolean;
  onDropInvalidChange: (value: boolean) => void;
}

const NEW = "__new__";
const IGNORE = "__ignore__";

function encode(target: ColumnTarget): string {
  return target.kind === "ignore" ? IGNORE : target.kind === "new" ? NEW : target.key;
}

/** Step 4: which sheet column feeds which store field; unknown columns can be added to the schema or ignored. */
export function MappingStep({ columns, rows, schema, mapping, onMappingChange, errors, problems, dropInvalid, onDropInvalidChange }: Props) {
  const sample = (column: string) =>
    [...new Set(rows.map((row) => (column === "pa" ? row.pa : (row.fields[column] ?? ""))).filter(Boolean))].slice(0, 3);
  const choose = (column: string, value: string) => {
    const target: ColumnTarget =
      value === IGNORE ? { kind: "ignore" } : value === NEW ? newFieldTarget(column, schema, mapping) : { kind: "field", key: value };
    onMappingChange({ ...mapping, [column]: target });
  };
  const requiredMissing = schema.filter(
    (field) => field.required && !Object.values(mapping).some((target) => target.kind !== "ignore" && target.key === field.key),
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Store name and address are always imported. Choose where every other column goes; columns matching a field by
        name were mapped automatically.
      </p>
      {columns.length === 0 ? (
        <p className="rounded-md border bg-slate-50 p-4 text-sm text-slate-500">This sheet has no extra columns to map.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
            <tr className="text-left">
              <th className="p-2">Sheet column</th>
              <th className="p-2">Sample values</th>
              <th className="p-2">Store field</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((column) => {
              const target = mapping[column] ?? { kind: "ignore" };
              return (
                <tr key={column} className="border-t">
                  <td className="p-2 font-mono text-xs">{column}</td>
                  <td className="max-w-56 truncate p-2 text-xs text-slate-500">{sample(column).join(" · ") || "—"}</td>
                  <td className="p-2">
                    <Select value={encode(target)} onValueChange={(value) => choose(column, value)}>
                      <SelectTrigger aria-label={`Field for column ${column}`} className="h-8 w-60">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {schema.map((field) => (
                          <SelectItem key={field.key} value={field.key}>
                            {field.label}
                          </SelectItem>
                        ))}
                        <SelectItem value={NEW}>
                          {target.kind === "new" ? `New field: ${target.label}` : "Add as a new field"}
                        </SelectItem>
                        <SelectItem value={IGNORE}>Ignore this column</SelectItem>
                      </SelectContent>
                    </Select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {errors.map((error) => (
        <p key={error} className="text-sm text-rose-600">
          {error}
        </p>
      ))}
      {requiredMissing.length > 0 && (
        <p className="text-sm text-rose-600">
          Required fields with no column: {requiredMissing.map((field) => field.label).join(", ")}.
        </p>
      )}
      {problems.length > 0 && (
        <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p>
            {problems.length} value{problems.length === 1 ? "" : "s"} would be rejected, e.g. row {(problems[0]?.index ?? 0) + 1}:{" "}
            {problems[0]?.message}.
          </p>
          <div className="flex items-center gap-2">
            <Checkbox id="drop-invalid" checked={dropInvalid} onCheckedChange={(checked) => onDropInvalidChange(checked === true)} />
            <Label htmlFor="drop-invalid">Import those stores with the invalid values left blank</Label>
          </div>
        </div>
      )}
    </div>
  );
}
