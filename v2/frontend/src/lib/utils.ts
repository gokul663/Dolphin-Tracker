import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind class lists; the helper shadcn/ui components expect. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
