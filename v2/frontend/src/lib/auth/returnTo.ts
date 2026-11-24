/** The page a person was on when they were sent to sign in, kept for this tab across the redirect. */
const KEY = "dolphin-tracker.return-to";

/** Where to land after sign-in: a path of this site only, never the sign-in pages themselves. */
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== "string" || raw === "") return "/";
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname.startsWith("/auth/")) return "/";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/";
  }
}

export function rememberReturnTo(raw: unknown) {
  try {
    window.sessionStorage.setItem(KEY, safeReturnTo(raw));
  } catch {
    // storage blocked: they land on the home page
  }
}

export function returnTo(): string {
  try {
    return safeReturnTo(window.sessionStorage.getItem(KEY));
  } catch {
    return "/";
  }
}

/** The page being looked at now, as a return address. */
export const here = () => safeReturnTo(window.location.pathname + window.location.search + window.location.hash);
