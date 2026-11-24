import { ApiError } from "@/lib/api/types";
import { authHeaders, cognitoOn, signInAgain } from "@/lib/auth/token";

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

/** `fetch` to our own API with the sign-in. A 401 is tried once more with a token renewed from the refresh token;
 *  when that fails too, the person goes back to the managed login (and returns to this page). */
async function send(url: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
  const call = async (renew: boolean) => {
    const auth = await authHeaders(renew);
    return { signedIn: "Authorization" in auth, response: await fetch(url, { ...init, headers: { ...auth, ...init.headers } }) };
  };
  let { signedIn, response } = await call(false);
  if (response.status === 401 && cognitoOn()) {
    if (signedIn) ({ signedIn, response } = await call(true));
    if (response.status === 401) void signInAgain();
  }
  return response;
}

/** Thin fetch wrapper: base URL, JSON, the sign-in's token, typed errors. */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, query, headers, ...init } = options;
  const response = await send(apiUrl(path, query), {
    ...init,
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(headers as Record<string, string> | undefined),
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
  // Our own route carries the sign-in; a presigned S3 URL must not (it is signed already).
  const response = await (uploadUrl.startsWith("/") ? send : fetch)(uploadUrl, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": contentType },
  });
  if (!response.ok) throw await toApiError(response);
}

/** GET a JSON document from a presigned URL or a local `/api/...` route (job results). */
export async function fetchJson<T>(url: string): Promise<T> {
  // Our own route carries the sign-in; a presigned S3 URL must not (it is signed already).
  const response = await (url.startsWith("/") ? send : fetch)(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as T;
}

/** Download a file from our API with the sign-in (a plain link would not carry it) and save it in the browser. */
export async function downloadFile(url: string, filename: string): Promise<void> {
  const response = await send(url);
  if (!response.ok) throw await toApiError(response);
  const href = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}
