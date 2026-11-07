import type { Pin, RoutesBundle, Stop, StorePage } from "@/lib/api/types";

/** Copy of a cached store-list page with one stop patched; the same object when the stop is not on it. */
export function patchStopInPage(data: StorePage | undefined, uid: string, patch: Partial<Stop>): StorePage | undefined {
  if (!data || !data.items.some((stop) => stop.uid === uid)) return data;
  return { ...data, items: data.items.map((stop) => (stop.uid === uid ? { ...stop, ...patch } : stop)) };
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
