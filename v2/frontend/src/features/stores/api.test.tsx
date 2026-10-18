import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { useAppendStores } from "@/features/stores/api";
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
