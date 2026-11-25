/** Dolphin Keystone: the one sign-in page for every Dolphin app (https://keystone.dolphin-one.com). With
 *  VITE_KEYSTONE_URL set, someone not signed in is shown Tracker's own "Sign in through Keystone" page and sent
 *  there; Keystone signs them in and sends them back, and Tracker then picks the session up without a prompt.
 *  Unset, Tracker goes straight to the shared login itself (lib/auth/cognito.ts). */

/** Set when this tab leaves for Keystone: coming back, the sign-in is finished without asking again. */
const VIA_KEY = "dolphin-tracker.via-keystone";

export const keystoneUrl = () => (import.meta.env.VITE_KEYSTONE_URL ?? "").replace(/\/+$/, "");

/** Keystone's sign-in page, returning to `page` (a full address of this site). */
export const keystoneLogin = (page: string) => `${keystoneUrl()}/login?returnTo=${encodeURIComponent(page)}`;

export function leaveForKeystone(): void {
  try {
    window.sessionStorage.setItem(VIA_KEY, "1");
  } catch {
    // storage blocked: back here they press the button once more
  }
  window.location.assign(keystoneLogin(window.location.href));
}

/** True once, on the page load that follows a trip to Keystone. */
export function backFromKeystone(): boolean {
  try {
    const back = window.sessionStorage.getItem(VIA_KEY) !== null;
    window.sessionStorage.removeItem(VIA_KEY);
    return back;
  } catch {
    return false;
  }
}
