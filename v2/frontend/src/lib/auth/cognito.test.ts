import { beforeEach, describe, expect, it, vi } from "vitest";

// aws-amplify is stood in for; what is tested is how lib/auth/cognito.ts drives it.
const amplify = vi.hoisted(() => ({
  configure: vi.fn(),
  fetchAuthSession: vi.fn(),
  signInWithRedirect: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
  clearTokens: vi.fn(async () => {}),
  listen: vi.fn(),
}));
vi.mock("aws-amplify", () => ({ Amplify: { configure: amplify.configure } }));
vi.mock("aws-amplify/auth", () => ({ fetchAuthSession: amplify.fetchAuthSession, signInWithRedirect: amplify.signInWithRedirect, signOut: amplify.signOut }));
vi.mock("aws-amplify/auth/cognito", () => ({ cognitoUserPoolsTokenProvider: { tokenOrchestrator: { clearTokens: amplify.clearTokens } } }));
vi.mock("aws-amplify/utils", () => ({ Hub: { listen: amplify.listen } }));

const session = (token: string, expiresInSeconds: number) => ({
  tokens: { idToken: { toString: () => token, payload: { exp: Math.floor(Date.now() / 1000) + expiresInSeconds } } },
});

/** The module as a newly loaded page has it (its "already leaving" flag is per page load). */
async function pageLoad() {
  vi.resetModules();
  return import("@/lib/auth/cognito");
}

beforeEach(() => {
  for (const mock of Object.values(amplify)) mock.mockClear();
  amplify.fetchAuthSession.mockResolvedValue({ tokens: undefined });
  window.sessionStorage.clear();
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_COGNITO_USER_POOL_ID", "us-east-1_Pool");
  vi.stubEnv("VITE_COGNITO_CLIENT_ID", "client123");
  vi.stubEnv("VITE_COGNITO_DOMAIN", "login.example.com");
  vi.stubEnv("VITE_COGNITO_PROVIDER", "");
});

describe("the shared login (Cognito managed login, code + PKCE)", () => {
  it("is set up from the env values with this site's callback and sign-out addresses", async () => {
    const auth = await pageLoad();
    expect(await auth.init()).toBe(false);
    expect(amplify.configure).toHaveBeenCalledWith({
      Auth: {
        Cognito: {
          userPoolId: "us-east-1_Pool",
          userPoolClientId: "client123",
          loginWith: {
            oauth: {
              domain: "login.example.com",
              scopes: ["openid", "email", "profile"],
              redirectSignIn: [`${window.location.origin}/auth/callback`],
              redirectSignOut: [`${window.location.origin}/`],
              responseType: "code",
            },
          },
        },
      },
    });
  });

  it("goes to the login page with both ways in by default, and straight to Google only when asked", async () => {
    let auth = await pageLoad();
    expect(await auth.signIn("/planner/p1")).toBe(true);
    expect(amplify.signInWithRedirect).toHaveBeenLastCalledWith({ customState: "/planner/p1" });
    expect(amplify.clearTokens).toHaveBeenCalled(); // Amplify will not start a sign-in while it holds a session
    window.sessionStorage.clear();
    vi.stubEnv("VITE_COGNITO_PROVIDER", "Google");
    auth = await pageLoad();
    await auth.signIn("https://evil.example.com/");
    expect(amplify.signInWithRedirect).toHaveBeenLastCalledWith({ customState: "/", provider: "Google" });
  });

  it("does not leave a second time when it came back not signed in, until asked to or a sign-in worked", async () => {
    await (await pageLoad()).signIn("/");
    const back = await pageLoad(); // the callback page, where the code exchange failed
    expect(await back.signIn("/")).toBe(false);
    expect(amplify.signInWithRedirect).toHaveBeenCalledTimes(1);
    expect(await back.signIn("/", true)).toBe(true); // "Try again"
    expect(amplify.signInWithRedirect).toHaveBeenCalledTimes(2);
    const later = await pageLoad();
    later.signInSettled(); // the server answered for the signed-in person
    expect(await later.signIn("/")).toBe(true);
    expect(amplify.signInWithRedirect).toHaveBeenCalledTimes(3);
  });

  it("does not leave at all when the site has no client ID", async () => {
    vi.stubEnv("VITE_COGNITO_CLIENT_ID", "");
    const auth = await pageLoad();
    expect(auth.missingConfig()).toBe("VITE_COGNITO_CLIENT_ID");
    expect(await auth.signIn("/")).toBe(false);
    expect(amplify.signInWithRedirect).not.toHaveBeenCalled();
  });

  it("hands out the ID token and renews it from the refresh token when it is about to expire or was refused", async () => {
    const auth = await pageLoad();
    amplify.fetchAuthSession.mockResolvedValue(session("fresh", 3600));
    expect(await auth.getToken()).toBe("fresh");
    expect(amplify.fetchAuthSession).toHaveBeenLastCalledWith({ forceRefresh: false });
    expect(await auth.getToken(true)).toBe("fresh"); // the server refused it
    expect(amplify.fetchAuthSession).toHaveBeenLastCalledWith({ forceRefresh: true });
    amplify.fetchAuthSession.mockResolvedValue(session("nearly-out", 10));
    await auth.getToken();
    amplify.fetchAuthSession.mockResolvedValue(session("renewed", 3600));
    expect(await auth.getToken()).toBe("renewed");
    expect(amplify.fetchAuthSession).toHaveBeenLastCalledWith({ forceRefresh: true });
    amplify.fetchAuthSession.mockRejectedValue(new Error("refresh token expired"));
    expect(await auth.getToken(true)).toBeNull();
  });

  it("signs out of the shared login too, ending at this site", async () => {
    await (await pageLoad()).signOut();
    expect(amplify.signOut).toHaveBeenCalledWith({ global: false, oauth: { redirectUrl: `${window.location.origin}/` } });
  });

  it("through Keystone, signing out ends at Keystone's sign-out so it is signed out too", async () => {
    vi.stubEnv("VITE_KEYSTONE_URL", "https://keystone.dolphin-one.com/");
    await (await pageLoad()).signOut();
    expect(amplify.signOut).toHaveBeenCalledWith({ global: false, oauth: { redirectUrl: "https://keystone.dolphin-one.com/signout" } });
    vi.unstubAllEnvs();
  });
});
