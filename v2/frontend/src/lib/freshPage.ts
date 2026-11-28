/**
 * After a deploy the old page's files are gone from the site, so a tab left open fails the first time it needs a
 * part it has not loaded yet ("Failed to fetch dynamically imported module"). Vite reports that as
 * `vite:preloadError`: load the page again to get the new version. At most once a minute, so a file that is really
 * missing shows the error instead of reloading forever.
 */
const KEY = "tracker.reloadedAt";
const GAP_MS = 60_000;

export function shouldReload(lastAt: number, now: number): boolean {
  return !lastAt || now - lastAt > GAP_MS;
}

export function reloadOnStalePage(): void {
  window.addEventListener("vite:preloadError", (event) => {
    let lastAt = 0;
    try {
      lastAt = Number(sessionStorage.getItem(KEY)) || 0;
      if (!shouldReload(lastAt, Date.now())) return;
      sessionStorage.setItem(KEY, String(Date.now()));
    } catch {
      return; // no storage: cannot tell a loop from a first try, so show the error
    }
    event.preventDefault(); // the import's error is not thrown; the page is about to be replaced
    window.location.reload();
  });
}
