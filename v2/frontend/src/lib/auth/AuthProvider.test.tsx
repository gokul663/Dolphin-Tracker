import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { AuthCallback, AuthProvider } from "@/lib/auth/AuthProvider";
import { Can } from "@/lib/auth/me";
import { rememberReturnTo, safeReturnTo } from "@/lib/auth/returnTo";
import { jsonError, makeMe, mockApi } from "@/test/render";

// The shared login itself (lib/auth/cognito.ts, over aws-amplify) is stood in for: these tests are about what the
// app does with it.
const cognito = vi.hoisted(() => ({
  init: vi.fn<() => Promise<boolean>>(),
  getToken: vi.fn<(renew?: boolean) => Promise<string | null>>(),
  signIn: vi.fn<(returnTo: string, again?: boolean) => Promise<boolean>>(),
  signOut: vi.fn(async () => {}),
  signInSettled: vi.fn(),
  signInFailure: vi.fn(() => ""),
  missingConfig: vi.fn(() => ""),
}));
vi.mock("@/lib/auth/cognito", () => cognito);

function renderGate(me: (url: URL, init: RequestInit) => unknown) {
  const api = mockApi({ "GET /api/me": me });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <p>the app</p>
        <Can permission="routes.manage" otherwise={<p>cannot plan</p>}>
          <p>can plan</p>
        </Can>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return api;
}

const bearer = (init: RequestInit) => (init.headers as Record<string, string>).Authorization;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("AuthProvider without sign-in (local work)", () => {
  it("shows the app once the server says who is signed in, with what their role allows", async () => {
    const api = renderGate(() => makeMe("operator"));
    expect(await screen.findByText("the app")).toBeTruthy();
    expect(screen.getByText("cannot plan")).toBeTruthy();
    expect(api.fetchMock.mock.calls[0]![1]!.headers).not.toHaveProperty("Authorization");
    expect(cognito.init).not.toHaveBeenCalled();
  });

  it("says so when the server asks for a sign-in this site was built without", async () => {
    renderGate(() => jsonError(401, "Sign in to use Dolphin Tracker"));
    expect(await screen.findByRole("heading", { name: "Sign-in is not set up" })).toBeTruthy();
    expect(screen.queryByText("the app")).toBeNull();
    expect(cognito.signIn).not.toHaveBeenCalled();
  });
});

describe("AuthProvider with the shared Dolphin Nexus login", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_AUTH_MODE", "cognito");
    for (const mock of Object.values(cognito)) mock.mockClear();
    cognito.init.mockResolvedValue(true);
    cognito.getToken.mockResolvedValue("id-token");
    cognito.signIn.mockResolvedValue(true);
    cognito.signInFailure.mockReturnValue("");
    cognito.missingConfig.mockReturnValue("");
  });

  it("goes straight to the managed login when not signed in, with the page to come back to", async () => {
    window.history.replaceState(null, "", "/planner/p1?day=2");
    cognito.init.mockResolvedValue(false);
    const api = renderGate(() => makeMe());
    await waitFor(() => expect(cognito.signIn).toHaveBeenCalledWith("/planner/p1?day=2", false));
    expect(screen.queryByText("the app")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull(); // no "Sign in" to click
    expect(api.calls).toEqual([]); // the server is not asked until there is a token
  });

  it("sends the ID token and shows the app once the server says who it is", async () => {
    const api = renderGate(() => makeMe("operator"));
    expect(await screen.findByText("the app")).toBeTruthy();
    expect(bearer(api.fetchMock.mock.calls[0]![1]!)).toBe("Bearer id-token");
    await waitFor(() => expect(cognito.signInSettled).toHaveBeenCalled());
    expect(cognito.signIn).not.toHaveBeenCalled();
  });

  it("does not go round again when it comes back from the login still not signed in", async () => {
    cognito.init.mockResolvedValue(false);
    cognito.signIn.mockResolvedValue(false); // this tab was just there
    cognito.signInFailure.mockReturnValue("User pool client does not exist");
    renderGate(() => makeMe());
    expect(await screen.findByRole("heading", { name: "Sign-in did not complete" })).toBeTruthy();
    expect(screen.getByText("User pool client does not exist")).toBeTruthy();
    expect(cognito.signIn).toHaveBeenCalledTimes(1);
    cognito.signIn.mockResolvedValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(cognito.signIn).toHaveBeenLastCalledWith("/", true);
  });

  it("renews the token when the server refuses it, and carries on", async () => {
    cognito.getToken.mockImplementation(async (renew) => (renew ? "renewed" : "stale"));
    const api = renderGate((_url, init) => (bearer(init) === "Bearer renewed" ? makeMe() : jsonError(401, "Your sign-in has expired")));
    expect(await screen.findByText("the app")).toBeTruthy();
    expect(api.calls).toHaveLength(2);
    expect(cognito.signIn).not.toHaveBeenCalled();
  });

  it("goes back to sign-in when the renewal fails too", async () => {
    cognito.getToken.mockImplementation(async (renew) => (renew ? null : "stale"));
    renderGate(() => jsonError(401, "Your sign-in has expired"));
    await waitFor(() => expect(cognito.signIn).toHaveBeenCalledWith("/"));
    expect(screen.queryByText("the app")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Sign-in is not set up" })).toBeNull();
  });

  it("tells an account with no role here, and lets them sign out", async () => {
    renderGate(() => jsonError(403, "Your account has no role in Dolphin Tracker"));
    expect(await screen.findByRole("heading", { name: "No access to Dolphin Tracker" })).toBeTruthy();
    expect(screen.getByText("Your account has no role in Dolphin Tracker")).toBeTruthy();
    expect(screen.getByText(/Ask an admin .* in Dolphin Nexus/)).toBeTruthy();
    expect(cognito.signIn).not.toHaveBeenCalled(); // signed in fine: a new sign-in would change nothing
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(cognito.signOut).toHaveBeenCalled();
  });

  it("names what is missing when the site was built without its Cognito values", async () => {
    cognito.missingConfig.mockReturnValue("VITE_COGNITO_CLIENT_ID");
    cognito.signIn.mockResolvedValue(false);
    renderGate(() => makeMe());
    expect(await screen.findByText(/VITE_COGNITO_CLIENT_ID/)).toBeTruthy();
    expect(cognito.init).not.toHaveBeenCalled();
  });
});

describe("/auth/callback", () => {
  const land = () =>
    render(
      <MemoryRouter initialEntries={["/auth/callback"]}>
        <Routes>
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/planner/:id" element={<p>the plan they were on</p>} />
          <Route path="/" element={<p>home</p>} />
        </Routes>
      </MemoryRouter>,
    );

  it("returns the person to the page they were on", () => {
    rememberReturnTo("/planner/p1?day=2");
    land();
    expect(screen.getByText("the plan they were on")).toBeTruthy();
  });

  it("lands on the home page when there is none, and never on another site or the callback itself", () => {
    land();
    expect(screen.getByText("home")).toBeTruthy();
    expect(["https://evil.example.com/x", "//evil.example.com", "/auth/callback?code=1", "", null, "/a?b=1#c"].map(safeReturnTo)).toEqual(["/", "/", "/", "/", "/", "/a?b=1#c"]);
  });
});

describe("AuthProvider signing in through Keystone", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_AUTH_MODE", "cognito");
    vi.stubEnv("VITE_KEYSTONE_URL", "https://keystone.dolphin-one.com/");
    window.sessionStorage.clear();
    for (const mock of Object.values(cognito)) mock.mockClear();
    cognito.init.mockResolvedValue(false);
    cognito.signIn.mockResolvedValue(true);
    cognito.missingConfig.mockReturnValue("");
  });

  it("shows Tracker's own sign-in page with the way to Keystone, instead of leaving on its own", async () => {
    const api = renderGate(() => makeMe());
    expect(await screen.findByRole("heading", { name: "Sign in to Dolphin Tracker" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in through Keystone" })).toBeTruthy();
    expect(screen.queryByText("the app")).toBeNull();
    expect(cognito.signIn).not.toHaveBeenCalled(); // not the bare login page
    expect(api.calls).toEqual([]);
  });

  it("the way there carries this page as the address to come back to", async () => {
    const { keystoneLogin } = await import("@/lib/auth/keystone");
    expect(keystoneLogin("https://tracker.dolphin-one.com/planner/p1?day=2")).toBe(
      "https://keystone.dolphin-one.com/login?returnTo=https%3A%2F%2Ftracker.dolphin-one.com%2Fplanner%2Fp1%3Fday%3D2",
    );
  });

  it("back from Keystone, finishes the sign-in without asking again", async () => {
    window.history.replaceState(null, "", "/planner/p1");
    window.sessionStorage.setItem("dolphin-tracker.via-keystone", "1");
    renderGate(() => makeMe());
    await waitFor(() => expect(cognito.signIn).toHaveBeenCalledWith("/planner/p1", false));
    expect(screen.queryByRole("button", { name: "Sign in through Keystone" })).toBeNull();
    expect(window.sessionStorage.getItem("dolphin-tracker.via-keystone")).toBeNull(); // once only
  });

  it("someone already signed in goes straight to the app", async () => {
    cognito.init.mockResolvedValue(true);
    cognito.getToken.mockResolvedValue("id-token");
    renderGate(() => makeMe());
    expect(await screen.findByText("the app")).toBeTruthy();
  });
});
