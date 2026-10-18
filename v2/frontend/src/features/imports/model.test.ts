import { describe, expect, it } from "vitest";
import {
  applyGeocode,
  autoMap,
  buildStops,
  extendedSchema,
  filterRows,
  mappableColumns,
  mappedValueProblems,
  mappingErrors,
  newFieldTarget,
  normalizeColumn,
  reviewSummary,
  rowProblems,
  toReviewRows,
  type ReviewRow,
} from "@/features/imports/model";
import type { GeocodeResult, ImportResult, ImportRow } from "@/lib/api/types";
import { DEFAULT_SCHEMA_FOR_TESTS as SCHEMA } from "@/test/schema";

function row(index: number, overrides: Partial<ImportRow> = {}): ImportRow {
  return {
    index, address: `${index} Main St`, store_name: `Store ${index}`, pa: "North", status: "valid", confidence: 100,
    verified_by: ["geocoding"], formatted: `${index} Main St, Atlanta, GA 30303, USA`, addr: `${index} Main St`,
    city: "Atlanta", state: "GA", zip: "30303", lat: 33.7, lng: -84.4, place_name: "", suggestions: [], error: "",
    coordinates_source: "geocode", installer_name: "", details: {}, screens: [], problems: {}, duplicate_of: null,
    duplicate_reason: "", external_id: `IBC-${index}`,
    venue_status: "Upcoming", venue_status_valid: true, venue_status_raw: "", fields: {}, ...overrides,
  };
}

const RESULT: ImportResult = {
  columns: ["store_name", "address", "pa", "dma", "owner_phone", "screens"], mapping: {}, address_column: "address", store_column: "store_name", extra_columns: ["owner_phone", "screens"],
  summary: { total: 4, valid: 2, needs_review: 1, invalid: 1, duplicates: 0 }, pa_names: ["North"],
  rows: [
    row(0, { fields: { dma: "ATL", owner_phone: "555-010-0100", screens: "3" }, venue_status: "Completed" }),
    row(1, { store_name: "", fields: { dma: "ATL", owner_phone: "call me", screens: "" } }),
    row(2, { status: "needs_review", confidence: 0, lat: null, lng: null, suggestions: ["2 Main St, Atlanta, GA"] }),
    row(3, { status: "invalid", address: "", lat: null, lng: null }),
  ],
};

const geo = (overrides: Partial<GeocodeResult> = {}): GeocodeResult => ({
  ok: true, status: "OK", formatted: "2 Main St, Atlanta, GA 30303, USA", lat: 33.71, lng: -84.41, addr: "2 Main St",
  city: "Atlanta", state: "GA", zip: "30303", partial: false, suggestions: [], error: "", ...overrides,
});

describe("review rows", () => {
  it("flags missing store names and unverified addresses, and summarises", () => {
    const rows = toReviewRows(RESULT);
    expect(rowProblems(rows[0] as ReviewRow)).toEqual([]);
    expect(rowProblems(rows[1] as ReviewRow)).toEqual(["Store name is required"]);
    expect(rowProblems(rows[2] as ReviewRow)).toEqual(["Address is not verified"]);
    expect(reviewSummary(rows)).toMatchObject({ total: 4, valid: 2, needs_review: 1, invalid: 1, blocked: 3, ready: 1 });
    expect(filterRows(rows, "blocked").map((r) => r.index)).toEqual([1, 2, 3]);
    const excluded = rows.map((r) => (r.index === 3 ? { ...r, excluded: true } : r));
    expect(reviewSummary(excluded)).toMatchObject({ excluded: 1, blocked: 2 });
  });

  it("re-validation updates geo and status like v1", () => {
    const [, , pending] = toReviewRows(RESULT);
    const fixed = applyGeocode(pending as ReviewRow, geo(), "2 Main St, Atlanta");
    expect(fixed).toMatchObject({ status: "valid", lat: 33.71, address: "2 Main St, Atlanta", addr: "2 Main St", error: "" });
    expect(applyGeocode(pending as ReviewRow, geo({ partial: true })).status).toBe("needs_review");
    const failed = applyGeocode(pending as ReviewRow, geo({ ok: false, suggestions: ["x"], error: "" }));
    expect(failed).toMatchObject({ status: "needs_review", suggestions: ["x"], error: "Could not geocode address" });
  });
});

describe("column mapping", () => {
  it("auto-maps by key, label or source column and leaves unknown columns ignored", () => {
    expect(normalizeColumn("﻿ Owner Phone #")).toBe("owner_phone");
    const columns = mappableColumns(RESULT);
    expect(columns).toEqual(["pa", "dma", "owner_phone", "screens"]);
    const schema = [...SCHEMA, { ...SCHEMA[0]!, key: "screen_count", label: "Screen Count", source_column: "Screens" }];
    expect(autoMap(columns, schema)).toEqual({
      pa: { kind: "field", key: "pa" },
      dma: { kind: "field", key: "dma" },
      owner_phone: { kind: "field", key: "owner_phone" },
      screens: { kind: "field", key: "screen_count" },
    });
    expect(autoMap(["screens"], SCHEMA)).toEqual({ screens: { kind: "ignore" } });
  });

  it("adds unknown columns to the schema with unique keys and catches double mappings", () => {
    const mapping = { ...autoMap(mappableColumns(RESULT), SCHEMA) };
    mapping.screens = newFieldTarget("screens", SCHEMA, mapping);
    expect(mapping.screens).toEqual({ kind: "new", key: "screens_field", label: "Screens" }); // "screens" is reserved
    const schema = extendedSchema(SCHEMA, mapping);
    expect(schema.at(-1)).toMatchObject({ key: "screens_field", source_column: "screens", type: "text" });
    expect(mappingErrors({ ...mapping, dma: { kind: "field", key: "pa" } })).toEqual(["pa and dma both map to pa"]);
  });

  it("builds stop inputs from ready rows and reports bad mapped values", () => {
    const rows = toReviewRows(RESULT).map((r) => (r.index === 1 ? { ...r, store_name: "Named now" } : r));
    const mapping = { ...autoMap(mappableColumns(RESULT), SCHEMA), screens: newFieldTarget("screens", SCHEMA, {}) };
    const schema = extendedSchema(SCHEMA, mapping);
    expect(mappedValueProblems(rows, mapping, schema)).toEqual([
      { index: 1, key: "owner_phone", message: "Owner Phone: enter a valid phone number" },
    ]);
    const stops = buildStops(rows, mapping, schema);
    expect(stops).toHaveLength(2); // rows 2 and 3 are not verified
    expect(stops[0]).toMatchObject({
      store_name: "Store 0", addr: "0 Main St", lat: 33.7, initial_status: "Completed",
      geocoded: "0 Main St, Atlanta, GA 30303, USA",
      fields: { pa: "North", dma: "ATL", owner_phone: "555-010-0100", screens_field: "3" },
    });
    expect(stops[1]?.fields).toEqual({ pa: "North", dma: "ATL", owner_phone: "call me" });
    expect(buildStops(rows, mapping, schema, { dropInvalid: true })[1]?.fields).toEqual({ pa: "North", dma: "ATL" });
  });
});
