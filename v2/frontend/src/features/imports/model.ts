/**
 * Import wizard logic (STORE-MODEL §6), kept pure so it can be unit-tested:
 *   the server's column mapping (re-point a column) → review rows (fix, exclude; duplicates excluded) → stop inputs.
 */
import { splitCodes } from "@/lib/codes";
import type {
  GeocodeResult,
  ImportResult,
  ImportRow,
  ScreenInput,
  StopInput,
  StoreFieldSpec,
  PlaceHit,
} from "@/lib/api/types";

export type RowStatus = ImportRow["status"] | "validating";

export interface ReviewRow extends Omit<ImportRow, "status"> {
  status: RowStatus;
  excluded: boolean;
  /** The row before a suggestion or a Google place was picked: "Undo" puts it back. */
  previous?: ReviewRow;
  /** "Add anyway": imported without a store name and/or a verified address, flagged as needing attention. */
  addAnyway?: boolean;
}

/** What "Add anyway" would accept for this row: a missing store name, an address Google did not verify. */
export function overridable(row: ReviewRow): ("store_name" | "address")[] {
  const reasons: ("store_name" | "address")[] = [];
  if (!row.store_name.trim()) reasons.push("store_name");
  if (!located(row)) reasons.push("address");
  return reasons;
}

/** Keep the row as it is now, so the next change can be undone (one step: the first pick is what Undo returns to). */
export const remember = (row: ReviewRow): ReviewRow =>
  row.previous ?? { ...row, previous: undefined };

export function undoPick(row: ReviewRow): ReviewRow {
  return row.previous
    ? { ...row.previous, excluded: row.excluded, previous: undefined }
    : row;
}

/** A place picked from Google's search results: the store goes at its pin. The typed street stays unless the
 *  place has a street address of its own. */
export function applyPlace(row: ReviewRow, hit: PlaceHit): ReviewRow {
  const hasStreet = /^\d/.test(hit.addr.trim());
  return {
    ...row,
    previous: remember(row),
    formatted: [hit.name, hit.formatted].filter(Boolean).join(" · "),
    addr: hasStreet ? hit.addr : row.addr,
    city: hit.city || row.city,
    state: hit.state || row.state,
    zip: hit.zip || row.zip,
    lat: hit.lat,
    lng: hit.lng,
    coordinates_source: "geocode",
    status: "valid",
    confidence: 90,
    verified_by: ["google search"],
    place_name: hit.name,
    suggestions: [],
    error: "",
  };
}

export type RowFilter =
  | "all"
  | "valid"
  | "needs_review"
  | "invalid"
  | "blocked"
  | "values"
  | "duplicates";

// ---- columns -------------------------------------------------------------------------------------------------

/** Backend `import_mapping`: "" keeps a column as Other imported data, "-" drops it. */
export const OTHER_DATA = "";
export const IGNORE = "-";

/** Targets that build the screens and the status, or carry sheet-only values (not store attributes). */
export const SHEET_TARGETS: { value: string; label: string }[] = [
  { value: "status", label: "Screen status" },
  { value: "status_fallback", label: "Screen status (if STATUS is blank)" },
  { value: "screen_count", label: "Number of screens (sticks)" },
  { value: "stick_numbers", label: "Stick numbers" },
  { value: "venue_ids", label: "DD codes (venue ids)" },
  { value: "lat", label: "Latitude" },
  { value: "lng", label: "Longitude" },
  { value: "installer_name", label: "Technician (completed by)" },
];

/** Re-pointing these needs new geocoding, which a re-map does not do: re-upload instead (backend rule). */
export const GEOCODED_TARGETS = new Set([
  "addr",
  "city",
  "state",
  "zip",
  "lat",
  "lng",
]);

export interface TargetGroup {
  label: string;
  options: { value: string; label: string }[];
}

export function targetGroups(specs: StoreFieldSpec[]): TargetGroup[] {
  return [
    {
      label: "Store fields",
      options: specs.map((spec) => ({ value: spec.name, label: spec.label })),
    },
    { label: "Screens and sheet values", options: SHEET_TARGETS },
    {
      label: "Other",
      options: [
        { value: OTHER_DATA, label: "Other imported data" },
        { value: IGNORE, label: "Ignore this column" },
      ],
    },
  ];
}

export function targetLabel(specs: StoreFieldSpec[], target: string): string {
  for (const group of targetGroups(specs)) {
    const option = group.options.find((item) => item.value === target);
    if (option) return option.label;
  }
  return target;
}

/** The column already holding `target`, other than `column` (each target is taken once; extras are not). */
export function takenBy(
  mapping: Record<string, string>,
  target: string,
  column: string,
): string | null {
  if (target === OTHER_DATA || target === IGNORE) return null;
  return (
    Object.entries(mapping).find(
      ([other, mapped]) => mapped === target && other !== column,
    )?.[0] ?? null
  );
}

export const isLocked = (target: string) => GEOCODED_TARGETS.has(target);

/** A few values this column produced, for the columns table. */
export function sampleValues(
  result: ImportResult,
  column: string,
  target: string,
  count = 3,
): string[] {
  const values: string[] = [];
  for (const row of result.rows) {
    let value: unknown;
    if (target === OTHER_DATA) value = row.fields[column];
    else if (target === "status" || target === "status_fallback")
      value = row.venue_status_raw;
    else if (target === "stick_numbers")
      value = row.screens
        .map((screen) => screen.stick_number)
        .filter(Boolean)
        .join(", ");
    else if (target === "venue_ids")
      value = row.screens
        .map((screen) => screen.venue_id)
        .filter(Boolean)
        .join(", ");
    else if (target === "screen_count") value = row.screens.length;
    else if (target in row.details) value = row.details[target];
    else if (target in row)
      value = (row as unknown as Record<string, unknown>)[target];
    if (value !== undefined && value !== null && value !== "")
      values.push(String(value));
    if (values.length >= count) break;
  }
  return values;
}

// ---- review rows -----------------------------------------------------------------------------------------------

export function toReviewRows(result: ImportResult): ReviewRow[] {
  return result.rows.map((row) => ({
    ...row,
    excluded: row.duplicate_reason !== "",
  }));
}

export const isDuplicate = (row: Pick<ImportRow, "duplicate_reason">) =>
  row.duplicate_reason !== "";

export function duplicateText(
  row: Pick<ImportRow, "duplicate_of" | "duplicate_reason">,
): string {
  const of =
    row.duplicate_of === null
      ? "an earlier row"
      : `row ${row.duplicate_of + 1}`;
  return row.duplicate_reason === "external_id"
    ? `Same IBC# as ${of}`
    : `Same address as ${of}`;
}

/** Apply a `/places/validate` answer to a row, as v1 did: ok and not partial → valid. */
export function applyGeocode(
  row: ReviewRow,
  geo: GeocodeResult,
  address = row.address,
): ReviewRow {
  if (!geo.ok) {
    return {
      ...row,
      address,
      status: "needs_review",
      confidence: 0,
      suggestions: geo.suggestions,
      error: geo.error || "Could not geocode address",
    };
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
    coordinates_source: "geocode",
    suggestions: geo.suggestions,
    status: geo.partial ? "needs_review" : "valid",
    confidence: geo.partial ? 40 : 70,
    verified_by: [
      geo.matched_by === "autocomplete" || geo.matched_by === "places"
        ? geo.matched_by
        : "geocoding",
    ],
    error: geo.partial
      ? "Google could not find this house number — pick a suggestion or correct the address"
      : "",
  };
}

/** The address can be routed: verified by Google, or (STORE-MODEL §6) placed by the sheet's own coordinates. */
export const located = (row: ReviewRow) =>
  row.lat !== null &&
  row.lng !== null &&
  (row.status === "valid" ||
    (row.status === "needs_review" && row.coordinates_source === "sheet"));

/** Screens whose DD code entry holds several codes ("DD-HJGK7Z. DD-HB8P6I"): it did not parse, so the row waits
 *  for a manual fix (split it, edit the sheet, or exclude the row). */
export const packedScreens = (row: Pick<ReviewRow, "screens">) =>
  row.screens.filter((screen) => splitCodes(screen.venue_id).length > 1);

/** The suggested fix: one screen per code, its stick at the same position when the counts match. */
export function splitRowScreens(row: Pick<ReviewRow, "screens">): ReviewRow["screens"] {
  return row.screens.flatMap((screen) => {
    const codes = splitCodes(screen.venue_id);
    if (codes.length < 2) return [screen];
    const sticks = splitCodes(screen.stick_number);
    const paired = sticks.length === codes.length;
    return codes.map((code, index) => ({
      ...screen,
      venue_id: code,
      stick_number: paired ? sticks[index]! : index === 0 ? screen.stick_number : "",
    }));
  });
}

/** Why a row cannot be imported (empty when it can). Excluded rows have none: they are skipped. An unverified
 *  address and an unparsed DD code block a row; other unusable values (a picture link, a phone) do not. */
export function rowProblems(row: ReviewRow): string[] {
  if (row.excluded) return [];
  const problems: string[] = [];
  if (!row.external_id.trim()) problems.push("IBC# is required");
  if (packedScreens(row).length) problems.push("DD code holds several codes: use the suggested split or fix the sheet");
  if (row.addAnyway) return problems; // the rest is accepted: the store is flagged as needing attention
  if (!row.store_name.trim()) problems.push("Store name is required");
  if (!located(row)) problems.push("Address is not verified");
  return problems;
}

/** Sheet values that could not be used (a bad phone, a non-numeric count…): fixed in the drawer later, or dropped. */
export function valueProblems(row: ReviewRow): string[] {
  if (row.excluded) return [];
  return Object.entries(row.problems)
    .filter(([key]) => key !== "external_id" && key !== "store_name" && key !== "venue_id") // venue_id blocks
    .map(([, message]) => message);
}

/** The columns with unusable values, most rows first: "Pictures (image URL)" → 78. */
export function valueProblemColumns(rows: ReviewRow[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (rowProblems(row).length > 0) continue;
    const columns = new Set(
      valueProblems(row).map((message) => message.split(":")[0].trim()),
    );
    for (const column of columns)
      counts.set(column, (counts.get(column) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

export function filterRows(rows: ReviewRow[], filter: RowFilter): ReviewRow[] {
  if (filter === "all") return rows;
  if (filter === "blocked")
    return rows.filter((row) => rowProblems(row).length > 0);
  if (filter === "values")
    return rows.filter(
      (row) => rowProblems(row).length === 0 && valueProblems(row).length > 0,
    );
  if (filter === "duplicates") return rows.filter(isDuplicate);
  return rows.filter((row) => row.status === filter);
}

export function reviewSummary(rows: ReviewRow[]) {
  const active = rows.filter((row) => !row.excluded);
  return {
    total: rows.length,
    valid: rows.filter((row) => row.status === "valid").length,
    needs_review: rows.filter((row) => row.status === "needs_review").length,
    invalid: rows.filter((row) => row.status === "invalid").length,
    duplicates: rows.filter(isDuplicate).length,
    excluded: rows.length - active.length,
    blocked: active.filter((row) => rowProblems(row).length > 0).length,
    withValueProblems: active.filter(
      (row) => rowProblems(row).length === 0 && valueProblems(row).length > 0,
    ).length,
    ready: active.filter((row) => rowProblems(row).length === 0).length,
    needsAttention: active.filter(
      (row) =>
        row.addAnyway &&
        rowProblems(row).length === 0 &&
        overridable(row).length > 0,
    ).length,
  };
}

/** One stop input per ready row: store attributes, screens with the sheet status, unrecognised columns as `fields`.
 *  `dropInvalid` leaves out the values listed in a row's problems (otherwise the server would refuse the row). */
export function buildStops(
  rows: ReviewRow[],
  { dropInvalid = false } = {},
): StopInput[] {
  return rows
    .filter((row) => !row.excluded && rowProblems(row).length === 0)
    .map((row) => {
      const details = Object.fromEntries(
        Object.entries(row.details).filter(
          ([key]) => !(dropInvalid && key in row.problems),
        ),
      );
      const unverified = Boolean(row.addAnyway) && !located(row);
      const screens: ScreenInput[] = row.screens.map((screen) => ({
        stick_number: screen.stick_number,
        venue_id: screen.venue_id,
        status: screen.status,
      }));
      return {
        ...details,
        external_id: row.external_id.trim(),
        store_name: row.store_name.trim(),
        addr: row.addr || row.address,
        city: row.city,
        state: row.state,
        zip: row.zip,
        // Added anyway without a verified address: no pin (a town-level guess would mislead the map and routes).
        lat: unverified ? null : row.lat,
        lng: unverified ? null : row.lng,
        geocoded: unverified ? "" : row.formatted,
        needs_attention: row.addAnyway ? overridable(row) : [],
        pa: row.pa,
        installer_name: row.installer_name,
        screens,
        fields: row.fields,
      } as StopInput;
    });
}

/** Screen rows as one short line for the review table: "2 screens · S1/V1, S2/V2". */
export function screensPreview(row: Pick<ImportRow, "screens">): string {
  const ids = row.screens
    .map((screen) =>
      [screen.stick_number, screen.venue_id].filter(Boolean).join("/"),
    )
    .filter(Boolean);
  const count = `${row.screens.length} ${row.screens.length === 1 ? "screen" : "screens"}`;
  return ids.length ? `${count} · ${ids.join(", ")}` : count;
}
