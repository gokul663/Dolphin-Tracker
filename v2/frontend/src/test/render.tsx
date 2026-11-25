import type { ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { keys } from "@/lib/api/keys";
import type { Me, Permission, Role } from "@/lib/api/types";

const VIEW: Permission[] = ["projects.view", "routes.view"];
const ALL: Permission[] = [...VIEW, "projects.edit", "stores.delete", "installers.manage", "routes.manage", "routes.arrange", "visits.log"];
/** The server's role table, for tests (backend domain/auth.py ROLE_PERMISSIONS). */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  super_admin: ALL,
  admin: ALL,
  operator: [...VIEW, "routes.arrange", "visits.log"],
  viewer: VIEW,
  technician: ["routes.own"],
};
export const makeMe = (role: Role = "super_admin"): Me => ({ id: "u1", name: "Test User", email: "", role, installer_id: "", acting_by: "", permissions: ROLE_PERMISSIONS[role] });

/** Render with a fresh query client (no retries), a router at `path`, and the tooltip provider. The signed-in person
 *  is a Super Admin unless `role` says otherwise. */
export function renderWithProviders(ui: ReactElement, { path = "/", route = "/", role = "super_admin" }: { path?: string; route?: string; role?: Role } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(keys.me, makeMe(role));
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

type Handler = (url: URL, init: RequestInit) => unknown; // may return a Promise (e.g. to hold a response)

/** Stub `fetch` with a router: `routes["GET /api/projects"] = () => body`. Unmatched calls fail the test loudly. */
export function mockApi(routes: Record<string, Handler>) {
  const calls: { method: string; url: URL; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ method, url, body });
    let handler = routes[`${method} ${url.pathname}`];
    // The Stores page asks for its map side in one request (/stores/overview). A test that mocks the four parts
    // (pins, filters, by-state, hardware) gets the overview made of them, so each part can still be set on its own.
    if (!handler && method === "GET" && url.pathname.endsWith("/stores/overview")) {
      const base = url.pathname.slice(0, -"/overview".length);
      const part = async (name: string, fallback: unknown) => {
        const own = routes[`GET ${base}/${name}`];
        return own ? await own(url, init) : fallback;
      };
      handler = async () => ({
        pins: await part("pins", []),
        filters: await part("filters", {}),
        by_state: await part("by-state", []),
        hardware: await part("hardware", { installed_screens: 0, installed_stores: 0, installed_dolphin_by_model: {} }),
      });
    }
    if (!handler) return new Response(JSON.stringify({ detail: `No mock for ${method} ${url.pathname}` }), { status: 599 });
    const result: unknown = await handler(url, init);
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
