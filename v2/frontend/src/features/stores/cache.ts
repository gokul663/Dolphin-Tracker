import type { InfiniteData } from "@tanstack/react-query";
import type { Page, Pin, RoutesBundle, Stop } from "@/lib/api/types";

export type StopPages = InfiniteData<Page<Stop>, string | null>;

/** Copy of the cached pages with one stop patched; untouched pages keep their identity. */
export function patchStopInPages(data: StopPages | undefined, uid: string, patch: Partial<Stop>): StopPages | undefined {
  if (!data) return data;
  let changed = false;
  const pages = data.pages.map((page) => {
    if (!page.items.some((stop) => stop.uid === uid)) return page;
    changed = true;
    return { ...page, items: page.items.map((stop) => (stop.uid === uid ? { ...stop, ...patch } : stop)) };
  });
  return changed ? { ...data, pages } : data;
}

/** Pins carry status, so a progress edit recolours the map immediately too. */
export function patchPin(pins: Pin[] | undefined, uid: string, patch: Partial<Stop>): Pin[] | undefined {
  if (!pins || patch.status === undefined) return pins;
  const status = patch.status;
  return pins.map((pin) => (pin.uid === uid ? { ...pin, status } : pin));
}

/** Copy of the routes bundle with one stop patched; untouched installers and days keep their identity. */
export function patchStopInRoutes(bundle: RoutesBundle | undefined, uid: string, patch: Partial<Stop>): RoutesBundle | undefined {
  if (!bundle) return bundle;
  let changed = false;
  const routes = Object.fromEntries(
    Object.entries(bundle.routes).map(([installer, days]) => {
      if (!days.some((day) => day.some((stop) => stop.uid === uid))) return [installer, days];
      changed = true;
      return [installer, days.map((day) => (day.some((stop) => stop.uid === uid) ? day.map((stop) => (stop.uid === uid ? { ...stop, ...patch } : stop)) : day))];
    }),
  );
  return changed ? { ...bundle, routes } : bundle;
}
