/** What the API client sends to say who is calling. With sign-in on (VITE_AUTH_MODE=cognito) that is the ID token
 *  of the shared Dolphin Nexus login, kept and renewed by lib/auth/cognito.ts. Without a login (local work) a role
 *  can be tried instead: the server honours `X-Dev-Role` only while its sign-in is off. */
import { here } from "@/lib/auth/returnTo";

const DEV_ROLE_KEY = "dolphin-tracker.dev-role";
const DEV_INSTALLER_KEY = "dolphin-tracker.dev-installer";

/** Whether this site signs people in. Off (the default) is local work against an API whose sign-in is off too. */
export const cognitoOn = () => import.meta.env.VITE_AUTH_MODE === "cognito";
/** Loaded on first use, so a site without sign-in never downloads or runs the Cognito library. */
export const cognito = () => import("@/lib/auth/cognito");

const read = (store: () => Storage, key: string): string | null => {
  try {
    return store().getItem(key);
  } catch {
    return null; // storage blocked
  }
};
const write = (store: () => Storage, key: string, value: string | null) => {
  try {
    if (value === null) store().removeItem(key);
    else store().setItem(key, value);
  } catch {
    // storage blocked: the value lives for this page only
  }
};

let devRole: string | null = read(() => window.localStorage, DEV_ROLE_KEY);

export function setDevRole(role: string | null) {
  devRole = role;
  write(() => window.localStorage, DEV_ROLE_KEY, role);
}

export function getDevRole() {
  return devRole;
}

let devInstaller: string | null = read(() => window.localStorage, DEV_INSTALLER_KEY);

/** Without a login: which installer "View as Technician" is. */
export function setDevInstaller(name: string | null) {
  devInstaller = name;
  write(() => window.localStorage, DEV_INSTALLER_KEY, name);
}

export function getDevInstaller() {
  return devInstaller;
}

/** The headers every call to our own API carries. `renew` asks for a token fresh from the refresh token (the
 *  server refused the one we had). */
export async function authHeaders(renew = false): Promise<Record<string, string>> {
  if (cognitoOn()) {
    const token = await (await cognito()).getToken(renew);
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
  return {
    ...(devRole ? { "X-Dev-Role": devRole } : {}),
    ...(devRole && devInstaller ? { "X-Dev-Installer": devInstaller } : {}),
  };
}

/** Back to the managed login, returning to this page. False when that was just tried and did not work. */
export async function signInAgain(): Promise<boolean> {
  return cognitoOn() ? (await cognito()).signIn(here()) : false;
}

/** The signed-in person's profile photo ("" without a login, or when the login has none for them). */
export async function profilePicture(): Promise<string> {
  return cognitoOn() ? (await cognito()).profilePicture() : "";
}

export async function signOut(): Promise<void> {
  if (cognitoOn()) await (await cognito()).signOut();
}
