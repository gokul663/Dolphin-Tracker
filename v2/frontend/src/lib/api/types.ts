/**
 * API types. Every record shape is an alias of the OpenAPI-generated `schema.d.ts` (`npm run gen:api` or
 * `make gen-api`); nothing here re-declares a server shape by hand.
 */
import type { components } from "@/lib/api/schema";

type Schemas = components["schemas"];

export type HealthResponse = Schemas["HealthResponse"];
export type Project = Schemas["Project"];
export type ProjectSummary = Schemas["ProjectSummary"];
export type ProjectCreate = Schemas["ProjectCreate"];
export type ProjectCreated = Schemas["ProjectCreated"];
export type ProjectUpdate = Schemas["ProjectUpdate"];
export type Kpi = Schemas["Kpi"];
export type Breakdown = Schemas["Breakdown"];
export type FieldDef = Schemas["FieldDef-Output"];
export type FieldDefInput = Schemas["FieldDef-Input"];
export type FieldType = Schemas["FieldType"];
export type Stop = Schemas["Stop"];
export type StopInput = Schemas["StopInput"];
export type ScreenStatus = Schemas["ScreenStatus"];
/** A store's status is its screens' derived status, so one vocabulary covers both. */
export type StopStatus = ScreenStatus;
export type Screen = Schemas["Screen"];
export type ScreenInput = Schemas["ScreenInput"];
export type ScreensUpdate = Schemas["ScreensUpdate"];
export type Pin = Schemas["Pin"];
export type StoreDetailsUpdate = Schemas["StoreDetailsUpdate"];
export type ProgressUpdate = Schemas["ProgressUpdate"];
export type StoreFilterOptions = Schemas["StoreFilterOptions"];
export type FilterOption = Schemas["FilterOption"];
export type StateCount = Schemas["StateCount"];
export type StoreFieldSpec = Schemas["StoreFieldSpec"];
export type SkippedStop = Schemas["SkippedStop"];
export type AppendStops = Schemas["AppendStops"];
export type AppendResult = Schemas["AppendResult"];
export type RoutesBundle = Schemas["RoutesBundle"];
export type InstallerStats = Schemas["InstallerStats"];
export type RoutingStatus = Schemas["RoutingStatus"];
export type ReassignResult = Schemas["ReassignResult"];
export type Job = Schemas["Job"];
export type JobView = Schemas["JobView"];
export type JobAccepted = Schemas["JobAccepted"];
export type JobStatus = Schemas["JobStatus"];
export type ImportJobCreate = Schemas["ImportJobCreate"];
export type ImportJobCreated = Schemas["ImportJobCreated"];
export type ImportResult = Schemas["ImportResult"];
export type ImportRow = Schemas["ImportRow"];
export type GeocodeResult = Schemas["GeocodeResult"];
export type MapsConfig = Schemas["MapsConfig"];

/** `Page[T]` from the backend: every list endpoint returns this with an opaque cursor. */
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

/** STORE-MODEL §4.2, in derivation precedence (least progressed first). */
export const STOP_STATUSES: readonly ScreenStatus[] = [
  "Upcoming",
  "Invitation Email Sent",
  "Shipped",
  "Delivered",
  "Serviced - Needs More Work",
  "Offline",
  "Completed",
  "Archived",
  "Cancelled",
];

/** Still needs a technician visit, so it is routed. Offline is not (STORE-MODEL §7 #2). */
export const PENDING_STATUSES: ReadonlySet<ScreenStatus> = new Set([
  "Upcoming",
  "Invitation Email Sent",
  "Shipped",
  "Delivered",
  "Serviced - Needs More Work",
]);

export const isPending = (status: ScreenStatus) => PENDING_STATUSES.has(status);

/** The least-progressed status among `statuses` (how a store's status derives from its screens). */
export function deriveStatus(statuses: Iterable<ScreenStatus>): ScreenStatus {
  const present = new Set(statuses);
  return STOP_STATUSES.find((status) => present.has(status)) ?? "Upcoming";
}

/** Body of a 422 raised by a service rule (`ValidationFailed`): message plus optional structured parts. */
export interface ValidationDetail {
  message: string;
  errors?: string[];
  stops?: { index: number; errors: string[] }[];
  /** Detail edits: attribute → message for the store fields that broke a rule. */
  fields?: Record<string, string>;
  suggestions?: string[];
  google_status?: string | null;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** The structured 422 detail, when the server sent one. */
  get validation(): ValidationDetail | null {
    const inner = isRecord(this.detail) ? this.detail.detail : undefined;
    return isRecord(inner) && typeof inner.message === "string" ? (inner as unknown as ValidationDetail) : null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
