/** Dolphin Keystone: the one sign-in page for every Dolphin app (https://keystone.dolphin-one.com). With
 *  VITE_KEYSTONE_URL set, someone not signed in is sent straight to Keystone's sign-in page; Keystone signs them
 *  in (or already has) and sends them back, and Tracker then picks the session up without a prompt.
 *  Unset, Tracker goes straight to the shared login itself (lib/auth/cognito.ts). */

/** Set when this tab leaves for Keystone: coming back, the sign-in is finished without asking again. */
const VIA_KEY = "dolphin-tracker.via-keystone";

export const keystoneUrl = () => (import.meta.env.VITE_KEYSTONE_URL ?? "").replace(/\/+$/, "");

/** Keystone's sign-in page, returning to `page` (a full address of this site). */
export const keystoneLogin = (page: string) => `${keystoneUrl()}/login?returnTo=${encodeURIComponent(page)}`;

/** Leave for Keystone's sign-in page. False, and nothing happens, when the trip cannot be remembered (storage
 *  blocked): coming back we could not tell, and would leave again for ever. */
export function leaveForKeystone(): boolean {
  try {
    window.sessionStorage.setItem(VIA_KEY, "1");
    if (window.sessionStorage.getItem(VIA_KEY) === null) return false;
  } catch {
    return false;
  }
  navigate(keystoneLogin(window.location.href));
  return true;
}

/** Leaving the page, in one place so a test can watch it. */
export const leaving = { to: (address: string) => window.location.assign(address) };
const navigate = (address: string) => leaving.to(address);

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
