import { describe, expect, it } from "vitest";
import {
  applyGeocode,
  buildStops,
  duplicateText,
  filterRows,
  isLocked,
  reviewSummary,
  rowProblems,
  sampleValues,
  screensPreview,
  takenBy,
  targetGroups,
  toReviewRows,
  valueProblems,
  type ReviewRow,
} from "@/features/imports/model";
import type { GeocodeResult, ImportResult } from "@/lib/api/types";
import { makeImportRow as importRow } from "@/test/fixtures";
import { STORE_FIELDS_FOR_TESTS as SPECS } from "@/test/storeFields";

const RESULT: ImportResult = {
  columns: ["ibc", "store_name", "store_address", "dma", "stick_number", "brand"],
  mapping: { ibc: "external_id", store_name: "store_name", store_address: "addr", dma: "dma", stick_number: "stick_numbers", brand: "" },
  address_column: "store_address", store_column: "store_name", extra_columns: ["brand"],
  summary: { total: 4, valid: 3, needs_review: 1, invalid: 0, duplicates: 1 }, pa_names: ["North"],
  rows: [
    importRow(0, {
      details: { dma: "ATL", owner_email: "nope" }, problems: { owner_email: "Store owner email: enter a valid email" },
      screens: [{ stick_number: "S1", venue_id: "V1", status: "Completed" }, { stick_number: "S2", venue_id: "", status: "Completed" }],
      venue_status: "Completed", fields: { brand: "Acme" }, installer_name: "self install",
    }),
    importRow(1, { external_id: "", problems: { external_id: "IBC# is required" }, details: { dma: "ATL" } }),
    importRow(2, { status: "needs_review", confidence: 0, coordinates_source: "sheet", lat: 34.1, lng: -84.2, formatted: "" }),
    importRow(3, { duplicate_of: 0, duplicate_reason: "external_id", external_id: "IBC-0" }),
  ],
};

const geo = (overrides: Partial<GeocodeResult> = {}): GeocodeResult => ({
  ok: true, status: "OK", formatted: "2 Main St, Atlanta, GA 30303, USA", lat: 33.71, lng: -84.4, addr: "2 Main St",
  city: "Atlanta", state: "GA", zip: "30303", partial: false, suggestions: [], error: "", ...overrides,
});

describe("columns (STORE-MODEL §6)", () => {
  it("offers store fields, screen/sheet targets and Other / Ignore", () => {
    const groups = targetGroups(SPECS);
    expect(groups.map((group) => group.label)).toEqual(["Store fields", "Screens and sheet values", "Other"]);
    expect(groups[0]?.options[0]).toEqual({ value: "external_id", label: "IBC#" });
    expect(groups[1]?.options.map((option) => option.value)).toContain("venue_ids");
    expect(groups[2]?.options).toEqual([{ value: "", label: "Other imported data" }, { value: "-", label: "Ignore this column" }]);
  });

  it("knows which targets are taken and which columns are locked to the geocoding", () => {
    expect(takenBy(RESULT.mapping, "dma", "brand")).toBe("dma");
    expect(takenBy(RESULT.mapping, "dma", "dma")).toBeNull();
    expect(takenBy(RESULT.mapping, "", "dma")).toBeNull(); // Other data takes any number of columns
    expect([isLocked("addr"), isLocked("lat"), isLocked("dma")]).toEqual([true, true, false]);
  });

  it("shows what each column produced", () => {
    expect(sampleValues(RESULT, "dma", "dma")).toEqual(["ATL", "ATL"]);
    expect(sampleValues(RESULT, "brand", "")).toEqual(["Acme"]);
    expect(sampleValues(RESULT, "stick_number", "stick_numbers")).toEqual(["S1, S2"]);
    expect(sampleValues(RESULT, "store_name", "store_name", 2)).toEqual(["Store 0", "Store 1"]);
  });
});

describe("review rows", () => {
  const rows = toReviewRows(RESULT);

  it("excludes duplicates up front and says why", () => {
    expect(rows.map((row) => row.excluded)).toEqual([false, false, false, true]);
    expect(duplicateText(rows[3] as ReviewRow)).toBe("Same IBC# as row 1");
    expect(duplicateText({ duplicate_of: 1, duplicate_reason: "address" })).toBe("Same address as row 2");
    expect(filterRows(rows, "duplicates").map((row) => row.index)).toEqual([3]);
  });

  it("needs an IBC#, a name and a located address; sheet coordinates count as located", () => {
    expect(rows.map(rowProblems)).toEqual([[], ["IBC# is required"], [], []]);
    expect(valueProblems(rows[0] as ReviewRow)).toEqual(["Store owner email: enter a valid email"]);
    expect(valueProblems(rows[1] as ReviewRow)).toEqual([]); // the missing IBC# is a row problem, not a value one
    const summary = reviewSummary(rows);
    expect(summary).toMatchObject({ total: 4, duplicates: 1, excluded: 1, blocked: 1, ready: 2, withValueProblems: 1 });
  });

  it("re-validates a typed address like v1", () => {
    const fixed = applyGeocode(rows[2] as ReviewRow, geo(), "2 Main St, Atlanta");
    expect(fixed).toMatchObject({ status: "valid", lat: 33.71, coordinates_source: "geocode", address: "2 Main St, Atlanta" });
    expect(applyGeocode(rows[2] as ReviewRow, geo({ ok: false, suggestions: ["x"] })).status).toBe("needs_review");
  });

  it("builds stop inputs with attributes, screens, installer and other data", () => {
    const named = rows.map((row) => (row.index === 1 ? { ...row, external_id: "IBC-NEW" } : row));
    const stops = buildStops(named);
    expect(stops.map((stop) => stop.external_id)).toEqual(["IBC-0", "IBC-NEW", "IBC-2"]); // the duplicate is left out
    expect(stops[0]).toMatchObject({
      store_name: "Store 0", addr: "0 Main St", lat: 33.7, geocoded: "0 Main St, Atlanta, GA 30303, USA", pa: "North",
      dma: "ATL", owner_email: "nope", installer_name: "self install", fields: { brand: "Acme" },
      screens: [{ stick_number: "S1", venue_id: "V1", status: "Completed" }, { stick_number: "S2", venue_id: "", status: "Completed" }],
    });
    expect(stops[2]).toMatchObject({ lat: 34.1, geocoded: "" }); // placed by the sheet's coordinates
    expect(buildStops(named, { dropInvalid: true })[0]).not.toHaveProperty("owner_email");
  });

  it("previews screens", () => {
    expect(screensPreview(rows[0] as ReviewRow)).toBe("2 screens · S1/V1, S2");
    expect(screensPreview(rows[1] as ReviewRow)).toBe("1 screen");
  });
});
