import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { editedKeys, useAppendStores, useUpdateStoreDetails } from "@/features/stores/api";
import { useUpdateProject } from "@/features/projects/api";
import { makeProject, makeStop } from "@/test/fixtures";
import { jsonError } from "@/test/render";
import { keys } from "@/lib/api/keys";
import { mockApi } from "@/test/render";

function wrapperWith(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useAppendStores", () => {
  it("invalidates the dashboard list as well as the project", async () => {
    mockApi({ "POST /api/projects/p1/stores/append": () => ({ appended: 1, total: 4, skipped: [] }) });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(keys.projectList(200), []);
    client.setQueryData(keys.project("p1"), { id: "p1" });
    const { result } = renderHook(() => useAppendStores("p1"), { wrapper: wrapperWith(client) });
    await act(() => result.current.mutateAsync({ stops: [], pa: "" }));
    expect(client.getQueryState(keys.projectList(200))?.isInvalidated).toBe(true);
    expect(client.getQueryState(keys.project("p1"))?.isInvalidated).toBe(true);
  });
});

describe("useUpdateStoreDetails", () => {
  const listKey = (sort: string, q = "") => keys.storeList("p1", { status: [], installer: [], q, sort, dir: "asc" });

  function run(body: Parameters<ReturnType<typeof useUpdateStoreDetails>["mutateAsync"]>[0]["body"]) {
    mockApi({ "PATCH /api/projects/p1/stores/u1": () => makeStop() });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    for (const key of [listKey("store_name"), listKey("fields.dma"), listKey("display_id", "atl"), keys.pins("p1", {})]) {
      client.setQueryData(key, key[3] === "pins" ? [] : { pages: [], pageParams: [] });
    }
    const { result } = renderHook(() => useUpdateStoreDetails("p1"), { wrapper: wrapperWith(client) });
    return { client, done: act(() => result.current.mutateAsync({ uid: "u1", body })) };
  }
  const stale = (client: QueryClient, key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated;

  it("refetches only the lists the edit can reorder", async () => {
    const { client, done } = run({ fields: { dma: "MCN" } });
    await done;
    expect(stale(client, listKey("fields.dma"))).toBe(true); // sorted by the edited column
    expect(stale(client, listKey("display_id", "atl"))).toBe(true); // searching: membership may change
    expect(stale(client, listKey("store_name"))).toBe(false); // patched in place
    expect(stale(client, keys.pins("p1", {}))).toBe(false);
  });

  it("refetches lists and pins after an address edit", async () => {
    const { client, done } = run({ addr: "9 New St" });
    await done;
    expect(stale(client, listKey("store_name"))).toBe(true);
    expect(stale(client, keys.pins("p1", {}))).toBe(true);
  });

  it("spells extra fields as the list sorts them", () => {
    expect(editedKeys({ store_name: "x", fields: { dma: "A" } })).toEqual(new Set(["store_name", "fields.dma"]));
  });
});

describe("useUpdateProject", () => {
  it("refetches the project and dashboard on a 409 so a retry sends the current version", async () => {
    mockApi({ "PATCH /api/projects/p1": () => jsonError(409, "Project p1 was modified concurrently") });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(keys.project("p1"), makeProject());
    client.setQueryData(keys.projectList(200), []);
    const { result } = renderHook(() => useUpdateProject("p1"), { wrapper: wrapperWith(client) });
    await act(() => result.current.mutateAsync({ name: "X", expected_version: 1 }).catch(() => undefined));
    expect(client.getQueryState(keys.project("p1"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(keys.projectList(200))?.isInvalidated).toBe(true);
  });
});
