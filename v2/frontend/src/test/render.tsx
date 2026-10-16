import type { ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

/** Render with a fresh query client (no retries), a router at `path`, and the tooltip provider. */
export function renderWithProviders(ui: ReactElement, { path = "/", route = "/" }: { path?: string; route?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path={path} element={children} />
            <Route path="*" element={<div data-testid="navigated" />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
  return { client, ...render(ui, { wrapper }) };
}

type Handler = (url: URL, init: RequestInit) => unknown;

/** Stub `fetch` with a router: `routes["GET /api/projects"] = () => body`. Unmatched calls fail the test loudly. */
export function mockApi(routes: Record<string, Handler>) {
  const calls: { method: string; url: URL; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ method, url, body });
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) return new Response(JSON.stringify({ detail: `No mock for ${method} ${url.pathname}` }), { status: 599 });
    const result = handler(url, init);
    if (result instanceof Response) return result;
    return new Response(result === undefined ? null : JSON.stringify(result), {
      status: result === undefined ? 204 : 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

export function jsonError(status: number, detail: unknown) {
  return new Response(JSON.stringify({ detail }), { status, headers: { "Content-Type": "application/json" } });
}
