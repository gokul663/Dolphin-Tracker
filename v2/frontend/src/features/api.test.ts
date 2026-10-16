import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAllProjects } from "@/features/projects/api";
import { contentTypeFor, isJobActive } from "@/features/imports/api";

afterEach(() => vi.unstubAllGlobals());

describe("fetchAllProjects", () => {
  it("follows next_cursor until the last page", async () => {
    const pages = [
      { items: [{ id: "p1" }], next_cursor: "c1" },
      { items: [{ id: "p2" }], next_cursor: null },
    ];
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(pages.shift()))));
    vi.stubGlobal("fetch", fetchMock);
    const all = await fetchAllProjects();
    expect(all.map((project) => project.id)).toEqual(["p1", "p2"]);
    const second = new URL(fetchMock.mock.calls[1]?.[0] as string);
    expect(second.searchParams.get("cursor")).toBe("c1");
    expect(second.searchParams.get("limit")).toBe("200");
  });
});

describe("imports helpers", () => {
  it("derives a content type when the browser gives none", () => {
    expect(contentTypeFor(new File(["x"], "sites.csv"))).toBe("text/csv");
    expect(contentTypeFor(new File(["x"], "Sites.XLSX"))).toContain("spreadsheetml");
    expect(contentTypeFor(new File(["x"], "a.csv", { type: "text/plain" }))).toBe("text/plain");
  });

  it("knows which job states are still running", () => {
    expect(isJobActive({ status: "queued" })).toBe(true);
    expect(isJobActive({ status: "running" })).toBe(true);
    expect(isJobActive({ status: "succeeded" })).toBe(false);
    expect(isJobActive(undefined)).toBe(false);
  });
});
