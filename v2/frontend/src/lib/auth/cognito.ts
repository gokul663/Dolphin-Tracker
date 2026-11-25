import { Amplify } from "aws-amplify";
import { fetchAuthSession, signInWithRedirect, signOut as amplifySignOut } from "aws-amplify/auth";
import { cognitoUserPoolsTokenProvider } from "aws-amplify/auth/cognito";
import { Hub } from "aws-amplify/utils";
import { keystoneUrl } from "@/lib/auth/keystone";
import { rememberReturnTo, safeReturnTo } from "@/lib/auth/returnTo";

/**
 * The shared Dolphin Nexus login: its Cognito user pool's managed login page (authorization code + PKCE), the same
 * shape as Nexus's own frontend/src/auth/cognitoAuth.ts. The managed login keeps a session cookie on the Cognito
 * domain, so someone already signed in to another Dolphin app comes straight back with a code and no prompt.
 *
 * Tokens live in localStorage (Amplify's default) and renew from the refresh token (30 days). Loaded only when
 * VITE_AUTH_MODE=cognito (lib/auth/token.ts), so local work without a login never runs this.
 */

/** Set when this tab leaves for the login, cleared once the server has answered for the person who came back. While
 *  it is set, coming back still not signed in means sign-in failed: say so instead of leaving again (a loop). */
const ATTEMPT_KEY = "dolphin-tracker.sign-in-attempt";

const storage = {
  get: (key: string) => {
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string | null) => {
    try {
      if (value === null) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, value);
    } catch {
      // storage blocked: no loop guard across page loads; the guard below still holds for this page
    }
  },
};

/** Unix seconds the ID token we last handed out expires at; 0 when signed out. */
let expiresAt = 0;
/** The signed-in person's Google profile photo, when the login passes one on; "" otherwise. */
let picture = "";
let failure = "";
let leaving = false;

async function refresh(forceRefresh = false): Promise<string | null> {
  try {
    const idToken = (await fetchAuthSession({ forceRefresh })).tokens?.idToken;
    expiresAt = idToken && typeof idToken.payload.exp === "number" ? idToken.payload.exp : 0;
    const photo = idToken?.payload.picture;
    picture = typeof photo === "string" && photo.startsWith("https://") ? photo : "";
    return idToken ? idToken.toString() : null;
  } catch {
    expiresAt = 0;
    return null;
  }
}

/** Where signing out ends. Through Keystone (VITE_KEYSTONE_URL): its /signout, so Keystone is signed out too and
 *  one sign-out covers every Dolphin app. Otherwise this site's root, which asks for a sign-in again. The address
 *  must be one of the app client's allowed sign-out addresses in the login pool. */
const signOutTo = () => (keystoneUrl() ? `${keystoneUrl()}/signout` : `${window.location.origin}/`);

let configured = false;
function configure(): void {
  if (configured) return;
  configured = true;
  const env = import.meta.env;
  const callback = new URL(window.location.href);
  if (callback.pathname === "/auth/callback" && callback.searchParams.get("error")) {
    failure = callback.searchParams.get("error_description") ?? callback.searchParams.get("error") ?? "";
  }
  // Before configure: Amplify finishes a returning redirect (code → tokens) as soon as it is configured.
  Hub.listen("auth", ({ payload }) => {
    switch (payload.event) {
      case "signInWithRedirect_failure": {
        const error: unknown = payload.data?.error;
        failure ||= error instanceof Error ? error.message : "Sign-in was not completed";
        expiresAt = 0;
        break;
      }
      case "tokenRefresh_failure":
      case "signedOut":
        expiresAt = 0;
        break;
      case "customOAuthState":
        // The page they were on, sent along with the redirect, now that the code is exchanged.
        rememberReturnTo(payload.data);
        break;
    }
  });
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: env.VITE_COGNITO_USER_POOL_ID ?? "",
        userPoolClientId: env.VITE_COGNITO_CLIENT_ID ?? "",
        loginWith: {
          oauth: {
            domain: env.VITE_COGNITO_DOMAIN ?? "",
            scopes: ["openid", "email", "profile"],
            redirectSignIn: [`${window.location.origin}/auth/callback`],
            redirectSignOut: [signOutTo()],
            responseType: "code",
          },
        },
      },
    },
  });
}

/** What is missing from this site's build for sign-in to work ("" when nothing is). */
export function missingConfig(): string {
  const env = import.meta.env;
  const missing = (["VITE_COGNITO_USER_POOL_ID", "VITE_COGNITO_CLIENT_ID", "VITE_COGNITO_DOMAIN"] as const).filter((key) => !env[key]);
  return missing.join(", ");
}

/** Restore the session from storage, or finish the redirect back from the login. True when signed in. */
export async function init(): Promise<boolean> {
  configure();
  return (await refresh()) !== null; // waits for a code exchange in flight
}

/** The current ID token for the API, renewed from the refresh token when it is about to expire (or when `renew`
 *  says the server refused it). Null when signed out. */
export async function getToken(renew = false): Promise<string | null> {
  configure();
  return refresh(renew || (expiresAt > 0 && expiresAt * 1000 < Date.now() + 30_000));
}

/** The profile photo of whoever is signed in ("" when there is none or nobody is). */
export async function profilePicture(): Promise<string> {
  configure();
  await refresh();
  return picture;
}

/** Why the last sign-in did not complete, as the login reported it ("" when it did not say). */
export const signInFailure = () => failure;

/** Leave for the managed login and come back to `returnTo`. False (and nothing happens) when this tab already
 *  went there and came back not signed in: the caller says so, and `again` is the person asking to retry. */
export async function signIn(returnTo: string, again = false): Promise<boolean> {
  if (leaving) return true;
  if (missingConfig()) return false;
  if (!again && storage.get(ATTEMPT_KEY)) return false;
  configure();
  leaving = true;
  storage.set(ATTEMPT_KEY, String(Date.now()));
  // VITE_COGNITO_PROVIDER=Google skips the login page's chooser and goes straight to Google. Empty (the default)
  // shows the page with both Google and the password form.
  const provider = import.meta.env.VITE_COGNITO_PROVIDER === "Google" ? ("Google" as const) : undefined;
  try {
    await dropTokens();
    await signInWithRedirect({ customState: safeReturnTo(returnTo), ...(provider ? { provider } : {}) });
    return true;
  } catch (error) {
    leaving = false;
    failure = error instanceof Error ? error.message : "Could not reach the sign-in page";
    return false;
  }
}

/** Forget this browser's tokens without leaving the page. Amplify refuses to start a sign-in while it still holds
 *  a session, and we get here holding one when the server will not take it. */
async function dropTokens(): Promise<void> {
  try {
    await cognitoUserPoolsTokenProvider.tokenOrchestrator.clearTokens();
  } catch {
    // nothing held
  }
  expiresAt = 0;
}

/** The server has answered for the signed-in person (who they are, or that they have no role): sign-in worked. */
export function signInSettled() {
  storage.set(ATTEMPT_KEY, null);
  failure = "";
}

/** Sign out of this app and of the shared login (the managed login's cookie), ending at `signOutTo()`. */
export async function signOut(): Promise<void> {
  configure();
  storage.set(ATTEMPT_KEY, null);
  expiresAt = 0;
  // Name the address: left to choose, the library refuses one on another origin and the click does nothing.
  await amplifySignOut({ global: false, oauth: { redirectUrl: signOutTo() } });
}
