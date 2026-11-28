import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** A raised white surface on a tinted backdrop (the store window's cards): a soft shadow and a hairline ring in
 *  place of a drawn border, so cards sit on the page instead of boxing each other in. */
export const SURFACE = "rounded-xl bg-white shadow-sm ring-1 ring-slate-900/5";

/** Merge Tailwind class lists; the helper shadcn/ui components expect. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** A filter's button in the filter bar (the dropdowns, the date ranges, More Filters): a soft blue-grey fill, so
 *  the row of filters reads as controls and stands apart from the white status chips above it. A filter with
 *  something picked adds its brand tint on top. */
export const FILTER_TRIGGER = "border-slate-300 bg-slate-100 font-mono text-xs shadow-none hover:bg-slate-200";
