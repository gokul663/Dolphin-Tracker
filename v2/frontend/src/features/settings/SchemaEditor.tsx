import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SectionTitle } from "@/features/settings/DetailsSection";
import { useUpdateProject } from "@/features/projects/api";
import type { FieldDefInput, FieldType, Project } from "@/lib/api/types";
import { FIELD_TYPES, keyFromLabel, moveItem, schemaErrors } from "@/lib/validation/fields";

interface Row extends FieldDefInput {
  /** Saved keys are locked: renaming one would orphan the values already stored under it. */
  saved: boolean;
  optionsText: string;
}

const toRows = (project: Project): Row[] =>
  project.field_schema.map((field) => ({ ...field, saved: true, optionsText: field.options.join(", ") }));

const parseOptions = (text: string) => [...new Set(text.split(",").map((option) => option.trim()).filter(Boolean))];

export function toSchema(rows: Row[]): FieldDefInput[] {
  return rows.map(({ key, label, type, required, optionsText, source_column }) => ({
    key,
    label: label.trim(),
    type,
    required: Boolean(required),
    options: type === "select" ? parseOptions(optionsText) : [],
    source_column: source_column ?? null,
  }));
}

/** Store name and address are fixed required fields and are not part of the schema. */
export function SchemaEditor({ project }: { project: Project }) {
  const [rows, setRows] = useState<Row[]>(() => toRows(project));
  const [baseline, setBaseline] = useState(project.version);
  const update = useUpdateProject(project.id);
  if (baseline !== project.version && update.isIdle) {
    // The project changed elsewhere (another tab, import mapping): start again from the server's schema.
    setRows(toRows(project));
    setBaseline(project.version);
  }
  const schema = useMemo(() => toSchema(rows), [rows]);
  const errors = useMemo(() => schemaErrors(schema), [schema]);
  const invalid = Object.keys(errors).length > 0;
  const removedSaved = project.field_schema.filter((field) => !rows.some((row) => row.key === field.key));
  const dirty = JSON.stringify(schema) !== JSON.stringify(toSchema(toRows(project)));

  const patch = (index: number, change: Partial<Row>) =>
    setRows((current) =>
      current.map((row, i) => {
        if (i !== index) return row;
        const next = { ...row, ...change };
        if (!row.saved && change.label !== undefined) {
          next.key = keyFromLabel(change.label, current.filter((_, j) => j !== index).map((other) => other.key));
        }
        return next;
      }),
    );
  const addRow = () =>
    setRows((current) => [
      ...current,
      { key: keyFromLabel("new field", current.map((row) => row.key)), label: "New field", type: "text", required: false,
        options: [], source_column: null, saved: false, optionsText: "" },
    ]);

  const save = async () => {
    try {
      await update.mutateAsync({ field_schema: schema, expected_version: project.version });
      setBaseline(project.version + 1);
      toast.success("Field schema saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Save failed");
    }
  };

  return (
    <Card className="gap-4 p-5">
      <SectionTitle
        title="Store fields"
        hint="Store name and address are always required. These are the extra fields every store in this project carries."
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
            <tr className="text-left">
              <th className="p-2">Label</th>
              <th className="p-2">Key</th>
              <th className="p-2">Type</th>
              <th className="p-2">Options (comma-separated)</th>
              <th className="p-2 text-center">Required</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row.saved ? "s" : "n"}-${index}`} className="border-t align-top">
                <td className="p-2">
                  <Input aria-label={`Label for field ${index + 1}`} value={row.label} onChange={(e) => patch(index, { label: e.target.value })} />
                  {errors[index] && (
                    <ul className="mt-1 space-y-0.5 text-xs text-rose-600">
                      {errors[index].map((message) => (
                        <li key={message}>{message}</li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="p-2 pt-4 font-mono text-xs text-slate-500" title={row.saved ? "Saved keys cannot change" : undefined}>
                  {row.key}
                </td>
                <td className="p-2">
                  <Select value={row.type} onValueChange={(value) => patch(index, { type: value as FieldType })}>
                    <SelectTrigger aria-label={`Type for ${row.label}`} className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FIELD_TYPES.map((type) => (
                        <SelectItem key={type.value} value={type.value}>
                          {type.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td className="p-2">
                  <Input
                    aria-label={`Options for ${row.label}`}
                    value={row.optionsText}
                    disabled={row.type !== "select"}
                    placeholder={row.type === "select" ? "Gold, Silver, Bronze" : "—"}
                    onChange={(e) => patch(index, { optionsText: e.target.value })}
                  />
                </td>
                <td className="p-2 pt-4 text-center">
                  <Checkbox
                    aria-label={`${row.label} is required`}
                    checked={Boolean(row.required)}
                    onCheckedChange={(checked) => patch(index, { required: checked === true })}
                  />
                </td>
                <td className="whitespace-nowrap p-2">
                  <Button size="icon" variant="ghost" aria-label={`Move ${row.label} up`} disabled={index === 0}
                    onClick={() => setRows((current) => moveItem(current, index, index - 1))}>
                    <ArrowUp />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label={`Move ${row.label} down`} disabled={index === rows.length - 1}
                    onClick={() => setRows((current) => moveItem(current, index, index + 1))}>
                    <ArrowDown />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label={`Remove ${row.label}`}
                    onClick={() => setRows((current) => current.filter((_, i) => i !== index))}>
                    <Trash2 />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {removedSaved.length > 0 && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Removing {removedSaved.map((field) => field.label).join(", ")} hides those values from the Stores tab and CSV
          export. They stay stored, so adding the field back with the same key brings them back.
        </p>
      )}
      <div className="flex justify-between gap-2">
        <Button variant="outline" onClick={addRow}>
          <Plus /> Add field
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" disabled={!dirty} onClick={() => setRows(toRows(project))}>
            Discard
          </Button>
          <Button onClick={save} disabled={!dirty || invalid || update.isPending}>
            {update.isPending && <Loader2 className="animate-spin" />} Save fields
          </Button>
        </div>
      </div>
    </Card>
  );
}
