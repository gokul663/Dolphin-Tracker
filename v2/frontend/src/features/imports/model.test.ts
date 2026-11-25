import { describe, expect, it } from "vitest";
import {
  applyGeocode,
  applyPlace,
  overridable,
  undoPick,
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
  summary: { total: 4, valid: 3, needs_review: 1, invalid: 0, duplicates: 1, known: 0 }, pa_names: ["North"],
  rows: [
    importRow(0, {
      details: { dma: "ATL", owner_email: "nope" }, problems: { owner_email: "Store owner email: enter a valid email" },
      screens: [{ stick_number: "S1", venue_id: "V1", status: "Completed" }, { stick_number: "S2", venue_id: "", status: "Completed" }],
      venue_status: "Completed", fields: { brand: "Acme" }, installer_name: "self install",
    }),
    importRow(1, { external_id: "", problems: { external_id: "ExtID is required" }, details: { dma: "ATL" } }),
    importRow(2, { status: "needs_review", confidence: 0, coordinates_source: "sheet", lat: 34.1, lng: -84.2, formatted: "" }),
    importRow(3, { duplicate_of: 0, duplicate_reason: "external_id", external_id: "IBC-0" }),
  ],
};

const geo = (overrides: Partial<GeocodeResult> = {}): GeocodeResult => ({
  ok: true, status: "OK", formatted: "2 Main St, Atlanta, GA 30303, USA", lat: 33.71, lng: -84.4, addr: "2 Main St",
  city: "Atlanta", state: "GA", zip: "30303", partial: false, suggestions: [], error: "", matched_by: "", ...overrides,
});

describe("columns (STORE-MODEL §6)", () => {
  it("offers store fields, screen/sheet targets and Other / Ignore", () => {
    const groups = targetGroups(SPECS);
    expect(groups.map((group) => group.label)).toEqual(["Store fields", "Screens and sheet values", "Other"]);
    expect(groups[0]?.options[0]).toEqual({ value: "external_id", label: "ExtID" });
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
    expect(duplicateText(rows[3] as ReviewRow)).toBe("Same ExtID as row 1");
    expect(duplicateText({ duplicate_of: 1, duplicate_reason: "address" })).toBe("Same address as row 2");
    expect(filterRows(rows, "duplicates").map((row) => row.index)).toEqual([3]);
  });

  it("needs an ExtID, a name and a located address; sheet coordinates count as located", () => {
    expect(rows.map(rowProblems)).toEqual([[], ["ExtID is required"], [], []]);
    expect(valueProblems(rows[0] as ReviewRow)).toEqual(["Store owner email: enter a valid email"]);
    expect(valueProblems(rows[1] as ReviewRow)).toEqual([]); // the missing ExtID is a row problem, not a value one
    const summary = reviewSummary(rows);
    expect(summary).toMatchObject({ total: 4, duplicates: 1, excluded: 1, blocked: 1, ready: 2, withValueProblems: 1 });
  });

  it("re-validates a typed address like v1", () => {
    const fixed = applyGeocode(rows[2] as ReviewRow, geo(), "2 Main St, Atlanta");
    expect(fixed).toMatchObject({ status: "valid", lat: 33.71, coordinates_source: "geocode", address: "2 Main St, Atlanta" });
    expect(applyGeocode(rows[2] as ReviewRow, geo({ ok: false, suggestions: ["x"] })).status).toBe("needs_review");
  });

  it("a road-only answer stays in review; a business or suggestion match says so", () => {
    const roadOnly = applyGeocode(rows[2] as ReviewRow, geo({ partial: true }));
    expect(roadOnly.status).toBe("needs_review");
    expect(rowProblems(roadOnly)).toContain("Address is not verified");
    expect(applyGeocode(rows[2] as ReviewRow, geo({ matched_by: "places" })).verified_by).toEqual(["places"]);
    expect(applyGeocode(rows[2] as ReviewRow, geo({ matched_by: "autocomplete" })).verified_by).toEqual(["autocomplete"]);
  });

  it("a Google place picked by hand verifies the row at its pin, and Undo puts the row back", () => {
    const before = applyGeocode(rows[2] as ReviewRow, geo({ partial: true }), "101 S Council Rd, Sunset, TX 76270");
    const hit = { place_id: "p1", name: "Sunset Gas And Grill", formatted: "Sunset, TX 76270", lat: 33.45, lng: -97.77,
      addr: "", city: "Sunset", state: "TX", zip: "76270" };
    const picked = applyPlace(before, hit);
    expect(picked).toMatchObject({ status: "valid", lat: 33.45, lng: -97.77, formatted: "Sunset Gas And Grill · Sunset, TX 76270" });
    expect(picked.addr).toBe(before.addr); // the place has no street address: the typed street stays
    expect(picked.verified_by).toEqual(["google search"]);
    expect(rowProblems(picked)).toEqual([]);
    const undone = undoPick(picked);
    expect(undone).toMatchObject({ status: "needs_review", lat: before.lat, address: before.address });
    expect(undone.previous).toBeUndefined();
    // Two picks in a row: Undo goes back to before the first.
    const twice = applyPlace(picked, { ...hit, lat: 1 });
    expect(undoPick(twice).status).toBe("needs_review");
  });

  it("Add anyway: a row without a name or a verified address is imported, flagged, and without a map pin", () => {
    const unverified = { ...applyGeocode(rows[2] as ReviewRow, geo({ partial: true })), store_name: "" };
    expect(rowProblems(unverified)).toEqual(["Store name is required", "Address is not verified"]);
    expect(overridable(unverified)).toEqual(["store_name", "address"]);
    const anyway = { ...unverified, addAnyway: true };
    expect(rowProblems(anyway)).toEqual([]);
    expect(reviewSummary([anyway]).needsAttention).toBe(1);
    const [stop] = buildStops([anyway]);
    expect(stop).toMatchObject({ needs_attention: ["store_name", "address"], lat: null, lng: null, geocoded: "" });
    // A missing ExtID is accepted the same way: the store is flagged, and the ExtID is entered in the store later.
    const noId = { ...unverified, external_id: " " };
    expect(rowProblems(noId)).toContain("ExtID is required");
    expect(rowProblems({ ...noId, addAnyway: true })).toEqual([]);
    expect(buildStops([{ ...noId, addAnyway: true }])[0]).toMatchObject({ external_id: "" });
    expect(buildStops([{ ...noId, addAnyway: true }])[0]?.needs_attention).toContain("external_id");
    const [verified] = buildStops([{ ...applyGeocode(rows[2] as ReviewRow, geo()), store_name: "", addAnyway: true }]);
    expect(verified).toMatchObject({ needs_attention: ["store_name"], lat: 33.71 }); // the pin stays when verified
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

describe("DD code entries with several codes", () => {
  const packed = () =>
    ({
      ...toReviewRows({ ...RESULT, rows: [RESULT.rows[0]!] })[0]!,
      screens: [{ stick_number: "DD-002-02969. DD-002-01380", venue_id: "DD-HJGK7Z. DD-HB8P6I", status: "Completed" as const }],
      problems: { venue_id: "DD code: 'DD-HJGK7Z. DD-HB8P6I' looks like 2 codes", image_url: "Pictures: bad link" },
    }) as ReviewRow;

  it("block the row (unlike other unusable values), even with Add anyway", async () => {
    const { packedScreens } = await import("@/features/imports/model");
    const row = packed();
    expect(packedScreens(row)).toHaveLength(1);
    expect(rowProblems(row)).toContain("DD code holds several codes: use the suggested split or fix the sheet");
    expect(rowProblems({ ...row, addAnyway: true })).toContain("DD code holds several codes: use the suggested split or fix the sheet");
    expect(valueProblems(row)).toEqual(["Pictures: bad link"]); // a picture link still only warns
    expect(buildStops([row])).toEqual([]);
  });

  it("the suggestion makes one screen per code with its stick", async () => {
    const { splitRowScreens } = await import("@/features/imports/model");
    expect(splitRowScreens(packed()).map((screen) => [screen.stick_number, screen.venue_id, screen.status])).toEqual([
      ["DD-002-02969", "DD-HJGK7Z", "Completed"],
      ["DD-002-01380", "DD-HB8P6I", "Completed"],
    ]);
  });
});

describe("Screens in the review: split, swapped columns, DD code format", () => {
  const withScreens = (screens: { stick_number: string; venue_id: string }[]) =>
    ({
      ...toReviewRows({ ...RESULT, rows: [RESULT.rows[0]!] })[0]!,
      screens: screens.map((screen) => ({ ...screen, status: "Offline" as const })),
    }) as ReviewRow;

  it("the split pairs the row's sticks and codes by position, however each cell was separated", async () => {
    const { splitRowScreens } = await import("@/features/imports/model");
    // The sheet had the sticks comma-separated (two screens) and both DD codes on separate lines of one cell.
    const row = withScreens([
      { stick_number: "DD-002-01255", venue_id: "DD-HF94R6\nDD-HH91P7" },
      { stick_number: "DD-002-01897", venue_id: "" },
    ]);
    expect(splitRowScreens(row).map((screen) => [screen.stick_number, screen.venue_id])).toEqual([
      ["DD-002-01255", "DD-HF94R6"],
      ["DD-002-01897", "DD-HH91P7"],
    ]);
    // One stick for two codes: the second code has no stick.
    const one = withScreens([{ stick_number: "DD-002-0248", venue_id: "DD-HYMSO8 DD-H6F9KM" }]);
    expect(splitRowScreens(one).map((screen) => [screen.stick_number, screen.venue_id])).toEqual([
      ["DD-002-0248", "DD-HYMSO8"],
      ["", "DD-H6F9KM"],
    ]);
  });

  it("finds a stick number and DD code in each other's column, and swaps them", async () => {
    const { looksSwapped, swapScreen, swappedScreens, oddCodeScreens } = await import("@/features/imports/model");
    const row = withScreens([
      { stick_number: "DD-H6WKL4", venue_id: "DD-002-01356" },
      { stick_number: "DD-HDB08Y", venue_id: "" },
      { stick_number: "DD-002-04184", venue_id: "DD_HMP5QU" },
    ]);
    expect(row.screens.map(looksSwapped)).toEqual([true, true, false]);
    expect(swappedScreens(row)).toHaveLength(2);
    expect(oddCodeScreens(row)).toEqual([]); // a swapped pair is reported as swapped, not as a bad format
    expect(swapScreen(row.screens[0]!)).toMatchObject({ stick_number: "DD-002-01356", venue_id: "DD-H6WKL4" });
  });

  it("points out a DD code that is not DD-ABCDEF or DD_ABCDEF, without blocking the row", async () => {
    const { isDdCode, oddCodeScreens, hasScreenWarnings, filterRows, reviewSummary: summary } = await import("@/features/imports/model");
    expect(["DD-HF94R6", "dd_hf94r6", " DD-H6F9KM "].map(isDdCode)).toEqual([true, true, true]);
    expect(["DD-HF94R", "DD-HF94R67", "D-005-02987", "DD-002-01356", "HF94R6", "DD HF94R6"].map(isDdCode)).toEqual(Array(6).fill(false));
    const row = withScreens([
      { stick_number: "DD-002-01255", venue_id: "DD-HF94R" },
      { stick_number: "", venue_id: "DD-HH91P7" },
      { stick_number: "", venue_id: "" },
    ]);
    expect(oddCodeScreens(row).map((screen) => screen.venue_id)).toEqual(["DD-HF94R"]);
    expect(hasScreenWarnings(row)).toBe(true);
    expect(rowProblems(row)).toEqual([]); // shown, never blocking
    expect(filterRows([row], "screens")).toHaveLength(1);
    expect(summary([row]).screenWarnings).toBe(1);
    expect(hasScreenWarnings({ ...row, excluded: true })).toBe(false);
  });
});
