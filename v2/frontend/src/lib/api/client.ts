import { ApiError } from "@/lib/api/types";
import { getAccessToken } from "@/lib/auth/token";

const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "/api").replace(/\/$/, "");

type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  /** Arrays become repeated parameters (`status=A&status=B`); null/undefined are dropped. */
  query?: Record<string, QueryValue | readonly QueryValue[]>;
}

export function apiUrl(path: string, query?: RequestOptions["query"]): string {
  const url = new URL(`${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`, window.location.origin);
  for (const [key, raw] of Object.entries(query ?? {})) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (value !== undefined && value !== null) url.searchParams.append(key, String(value));
    }
  }
  return url.toString();
}

/** Human message from a FastAPI error body: string detail, our {message} detail, or pydantic's list. */
export function errorMessage(detail: unknown, fallback: string): string {
  if (typeof detail !== "object" || detail === null || !("detail" in detail)) return fallback;
  const inner = detail.detail;
  if (typeof inner === "string") return inner;
  if (typeof inner === "object" && inner !== null && "message" in inner && typeof inner.message === "string") {
    return inner.message;
  }
  if (Array.isArray(inner) && inner.length > 0) {
    const first: unknown = inner[0];
    if (typeof first === "object" && first !== null && "msg" in first && typeof first.msg === "string") {
      return first.msg;
    }
  }
  return fallback;
}

async function toApiError(response: Response): Promise<ApiError> {
  let detail: unknown;
  try {
    detail = await response.json();
  } catch {
    detail = undefined;
  }
  return new ApiError(response.status, errorMessage(detail, `${response.status} ${response.statusText}`), detail);
}

/** Thin fetch wrapper: base URL, JSON, bearer token when present, typed errors. */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, query, headers, ...init } = options;
  const token = getAccessToken();
  const response = await fetch(apiUrl(path, query), {
    ...init,
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * PUT a file to a presigned S3 URL (absolute) or the local-mode upload route (`/api/...`). The Content-Type must
 * equal the one sent to `POST /jobs/imports`: S3 signs it.
 */
export async function uploadFile(uploadUrl: string, file: Blob, contentType: string): Promise<void> {
  const isApiRoute = uploadUrl.startsWith("/");
  const token = isApiRoute ? getAccessToken() : null;
  const response = await fetch(uploadUrl, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": contentType, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!response.ok) throw await toApiError(response);
}

/** GET a JSON document from a presigned URL or a local `/api/...` route (job results). */
export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as T;
}
