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
export type StopStatus = Schemas["StopStatus"];
export type Pin = Schemas["Pin"];
export type StoreDetailsUpdate = Schemas["StoreDetailsUpdate"];
export type ProgressUpdate = Schemas["ProgressUpdate"];
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

export const STOP_STATUSES: readonly StopStatus[] = ["Incomplete", "Complete", "Technical Issue", "Other"];

/** Body of a 422 raised by a service rule (`ValidationFailed`): message plus optional structured parts. */
export interface ValidationDetail {
  message: string;
  errors?: string[];
  stops?: { index: number; errors: string[] }[];
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
