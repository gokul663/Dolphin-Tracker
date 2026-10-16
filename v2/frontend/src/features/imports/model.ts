/**
 * Import wizard logic, kept pure so it can be unit-tested:
 *   review rows (edit, re-validate, pick suggestions, exclude) → map sheet columns to schema fields → stop inputs.
 */
import type { FieldDef, FieldDefInput, GeocodeResult, ImportResult, ImportRow, StopInput } from "@/lib/api/types";
import { coreError, fieldError, isBlank, keyFromLabel } from "@/lib/validation/fields";

export type RowStatus = ImportRow["status"] | "validating";

export interface ReviewRow extends Omit<ImportRow, "status"> {
  status: RowStatus;
  excluded: boolean;
}

export type RowFilter = "all" | "valid" | "needs_review" | "invalid" | "blocked";

export function toReviewRows(result: ImportResult): ReviewRow[] {
  return result.rows.map((row) => ({ ...row, excluded: false }));
}

/** Backend `normalize_column`: lower-case, non-alphanumerics to "_", trimmed. */
export function normalizeColumn(value: string): string {
  return value.replace(/^﻿/, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Apply a `/places/validate` answer to a row, as v1 did: ok and not partial → valid. */
export function applyGeocode(row: ReviewRow, geo: GeocodeResult, address = row.address): ReviewRow {
  if (!geo.ok) {
    return { ...row, address, status: "needs_review", confidence: 0, suggestions: geo.suggestions, error: geo.error || "Could not geocode address" };
  }
  return {
    ...row,
    address,
    formatted: geo.formatted,
    addr: geo.addr || address,
    city: geo.city,
    state: geo.state,
    zip: geo.zip,
    lat: geo.lat,
    lng: geo.lng,
    suggestions: geo.suggestions,
    status: geo.partial ? "needs_review" : "valid",
    confidence: geo.partial ? 40 : 70,
    verified_by: ["geocoding"],
    error: geo.partial ? "Partial match — please review" : "",
  };
}

/** Why a row cannot be imported yet (empty when it can). Excluded rows have no problems: they are skipped. */
export function rowProblems(row: ReviewRow): string[] {
  if (row.excluded) return [];
  const problems: string[] = [];
  const name = coreError("store_name", row.store_name);
  if (name) problems.push(name);
  if (row.status !== "valid" || row.lat === null || row.lng === null) problems.push("Address is not verified");
  return problems;
}

export function filterRows(rows: ReviewRow[], filter: RowFilter): ReviewRow[] {
  if (filter === "all") return rows;
  if (filter === "blocked") return rows.filter((row) => rowProblems(row).length > 0);
  return rows.filter((row) => row.status === filter);
}

export function reviewSummary(rows: ReviewRow[]) {
  const active = rows.filter((row) => !row.excluded);
  return {
    total: rows.length,
    valid: rows.filter((row) => row.status === "valid").length,
    needs_review: rows.filter((row) => row.status === "needs_review").length,
    invalid: rows.filter((row) => row.status === "invalid").length,
    excluded: rows.length - active.length,
    blocked: active.filter((row) => rowProblems(row).length > 0).length,
    ready: active.filter((row) => rowProblems(row).length === 0).length,
  };
}

// ---- column mapping ----------------------------------------------------------------------------------------

export type ColumnTarget = { kind: "field"; key: string } | { kind: "new"; key: string; label: string } | { kind: "ignore" };
export type ColumnMapping = Record<string, ColumnTarget>;

/** Sheet columns that can feed custom fields: `pa` (top-level in the result) plus every key under `fields`. */
export function mappableColumns(result: ImportResult): string[] {
  const columns = new Set<string>();
  if (result.rows.some((row) => !isBlank(row.pa))) columns.add("pa");
  for (const row of result.rows) for (const key of Object.keys(row.fields)) columns.add(key);
  return [...columns];
}

function columnValue(row: Pick<ImportRow, "pa" | "fields">, column: string): string {
  return column === "pa" ? row.pa : (row.fields[column] ?? "");
}

/** Auto-map by alias: a column matches a field whose key, source column or label normalises to the same name. */
export function autoMap(columns: string[], schema: FieldDef[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  for (const column of columns) {
    const match = schema.find(
      (field) =>
        field.key === column ||
        (field.source_column && normalizeColumn(field.source_column) === column) ||
        normalizeColumn(field.label) === column,
    );
    mapping[column] = match ? { kind: "field", key: match.key } : { kind: "ignore" };
  }
  return mapping;
}

/** A "new field" target for an unknown column: label from the header, key unique against the schema. */
export function newFieldTarget(column: string, schema: FieldDef[], mapping: ColumnMapping): ColumnTarget {
  const label = column.split("_").filter(Boolean).map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" ") || column;
  const taken = [
    ...schema.map((field) => field.key),
    ...Object.values(mapping).flatMap((target) => (target.kind === "new" ? [target.key] : [])),
  ];
  return { kind: "new", key: keyFromLabel(label, taken), label };
}

export function mappingErrors(mapping: ColumnMapping): string[] {
  const targets = new Map<string, string[]>();
  for (const [column, target] of Object.entries(mapping)) {
    if (target.kind === "ignore") continue;
    targets.set(target.key, [...(targets.get(target.key) ?? []), column]);
  }
  return [...targets].filter(([, columns]) => columns.length > 1).map(([key, columns]) => `${columns.join(" and ")} both map to ${key}`);
}

/** The schema after the mapping's "add to schema" choices; new fields remember their sheet column. */
export function extendedSchema(schema: FieldDef[], mapping: ColumnMapping): FieldDefInput[] {
  const added: FieldDefInput[] = Object.entries(mapping).flatMap(([column, target]) =>
    target.kind === "new"
      ? [{ key: target.key, label: target.label, type: "text" as const, required: false, options: [], source_column: column }]
      : [],
  );
  return [...schema, ...added];
}

/** Values that would fail the server's field rules, per target key (shown on the mapping step). */
export function mappedValueProblems(rows: ReviewRow[], mapping: ColumnMapping, schema: FieldDefInput[]) {
  const problems: { index: number; key: string; message: string }[] = [];
  const byKey = new Map(schema.map((field) => [field.key, field]));
  for (const row of rows) {
    if (row.excluded || rowProblems(row).length) continue;
    for (const field of schema) {
      const column = Object.entries(mapping).find(([, target]) => target.kind !== "ignore" && target.key === field.key)?.[0];
      const value = column ? columnValue(row, column) : "";
      const definition = byKey.get(field.key);
      if (!definition) continue;
      const message = fieldError({ ...definition, required: Boolean(definition.required), options: definition.options ?? [] }, value);
      if (message) problems.push({ index: row.index, key: field.key, message });
    }
  }
  return problems;
}

/** Ready rows → `StopInput[]` for `POST /projects` or `stores/append`. `dropInvalid` blanks optional bad values. */
export function buildStops(
  rows: ReviewRow[],
  mapping: ColumnMapping,
  schema: FieldDefInput[],
  { dropInvalid = false }: { dropInvalid?: boolean } = {},
): StopInput[] {
  const bad = new Set(dropInvalid ? mappedValueProblems(rows, mapping, schema).map((p) => `${p.index}|${p.key}`) : []);
  return rows
    .filter((row) => !row.excluded && rowProblems(row).length === 0)
    .map((row) => {
      const fields: Record<string, string> = {};
      for (const [column, target] of Object.entries(mapping)) {
        if (target.kind === "ignore") continue;
        const value = columnValue(row, column).trim();
        if (value && !bad.has(`${row.index}|${target.key}`)) fields[target.key] = value;
      }
      return {
        store_name: row.store_name.trim(),
        addr: row.addr || row.address,
        city: row.city,
        state: row.state,
        zip: row.zip,
        lat: row.lat,
        lng: row.lng,
        geocoded: row.formatted || row.address,
        fields,
        initial_status: row.venue_status,
      };
    });
}
