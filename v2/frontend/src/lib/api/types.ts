/** Shared API shapes. Endpoint-specific types live next to their hooks. */

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page; absent on the last page. */
  next_cursor?: string | null;
}

export interface HealthResponse {
  status: "ok";
  env: string;
  db: boolean;
  ts: string;
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
}
