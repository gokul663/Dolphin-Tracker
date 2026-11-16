import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** A raised white surface on a tinted backdrop (the store window's cards): a soft shadow and a hairline ring in
 *  place of a drawn border, so cards sit on the page instead of boxing each other in. */
export const SURFACE = "rounded-xl bg-white shadow-sm ring-1 ring-slate-900/5";

/** Merge Tailwind class lists; the helper shadcn/ui components expect. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
