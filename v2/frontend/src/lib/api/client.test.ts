import { afterEach, describe, expect, it, vi } from "vitest";
import { api, apiUrl, errorMessage, uploadFile } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";

function respond(status: number, body: unknown) {
  return vi.fn().mockResolvedValue(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("apiUrl", () => {
  it("repeats array params and drops empty ones", () => {
    const url = new URL(apiUrl("/projects/p1/stores", { status: ["Completed", "Other"], installer: [""], q: undefined, limit: 50 }));
    expect(url.pathname).toBe("/api/projects/p1/stores");
    expect(url.searchParams.getAll("status")).toEqual(["Completed", "Other"]);
    expect(url.searchParams.getAll("installer")).toEqual([""]);
    expect(url.searchParams.has("q")).toBe(false);
    expect(url.searchParams.get("limit")).toBe("50");
  });
});

describe("errorMessage", () => {
  it("reads string, structured and pydantic details", () => {
    expect(errorMessage({ detail: "Project p not found" }, "x")).toBe("Project p not found");
    expect(errorMessage({ detail: { message: "Address could not be verified", suggestions: [] } }, "x")).toBe(
      "Address could not be verified",
    );
    expect(errorMessage({ detail: [{ msg: "Field required", loc: ["body", "name"] }] }, "x")).toBe("Field required");
    expect(errorMessage(undefined, "fallback")).toBe("fallback");
  });
});

describe("api", () => {
  it("returns JSON, sends JSON bodies and maps errors to ApiError with the 422 detail", async () => {
    const ok = respond(200, { id: "p1" });
    vi.stubGlobal("fetch", ok);
    await expect(api("/projects", { method: "POST", body: { name: "x" } })).resolves.toEqual({ id: "p1" });
    const [, init] = ok.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe('{"name":"x"}');
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    vi.stubGlobal("fetch", respond(422, { detail: { message: "Bad", suggestions: ["1 Main St"] } }));
    const error = await api("/x").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
    expect((error as ApiError).validation?.suggestions).toEqual(["1 Main St"]);
  });

  it("treats 204 as undefined", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(api("/projects/p1", { method: "DELETE" })).resolves.toBeUndefined();
  });
});

describe("uploadFile", () => {
  it("PUTs the raw file with the signed content type", async () => {
    const put = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", put);
    const file = new Blob(["address\n1 Main St\n"]);
    await uploadFile("https://bucket.s3.amazonaws.com/uploads/j/x.csv?X-Amz-Signature=s", file, "text/csv");
    const [url, init] = put.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("X-Amz-Signature");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("text/csv");
    expect(init.body).toBe(file);
  });
});
