import type { InfiniteData } from "@tanstack/react-query";
import type { Page, Pin, Stop } from "@/lib/api/types";

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
