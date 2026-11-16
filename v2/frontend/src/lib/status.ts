import type { components } from "@/lib/api/schema";
import type { ScreenStatus } from "@/lib/api/types";

/** One palette for chips, charts and map pins (STORE-MODEL §4.2). Upcoming is yellow (amber read too close to
 *  Offline's light red on the map), Completed green. */
export const STATUS_META: Record<ScreenStatus, { label: string; color: string; chip: string }> = {
  Upcoming: { label: "Upcoming", color: "#eab308", chip: "bg-yellow-50 text-yellow-800 border-yellow-300" },
  "Invitation Email Sent": { label: "Invitation Email Sent", color: "#0284c7", chip: "bg-sky-50 text-sky-700 border-sky-200" },
  Shipped: { label: "Shipped", color: "#4f46e5", chip: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  Delivered: { label: "Delivered", color: "#0d9488", chip: "bg-teal-50 text-teal-700 border-teal-200" },
  "Serviced - Needs More Work": {
    label: "Serviced - Needs More Work",
    color: "#c026d3",
    chip: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200",
  },
  Completed: { label: "Completed", color: "#16a34a", chip: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  Offline: { label: "Offline", color: "#dc2626", chip: "bg-rose-50 text-rose-700 border-rose-200" },
  Archived: { label: "Archived", color: "#64748b", chip: "bg-slate-100 text-slate-600 border-slate-200" },
  Cancelled: { label: "Cancelled", color: "#78716c", chip: "bg-stone-100 text-stone-600 border-stone-300" },
};

export const INSTALLER_COLORS = ["#0F5B7C", "#0891b2", "#7c3aed", "#dc2626", "#16a34a", "#ea580c", "#ca8a04"];

export const PROJECT_TYPE_LABELS: Record<string, string> = {
  new_installation: "New Installation",
  offline: "Offline",
  new_installation_and_offline: "New Installation + Offline",
};

/** The groups the UI shows (backend `StatusBucket`): KPI bubbles, filter chips, map pins and cluster bubbles.
 *  Stored statuses keep all nine; Archived reads as Cancelled. In Progress is not shown for now: its statuses count as
 *  Upcoming (to bring it back, add it to BUCKETS and point them at it in BUCKET_OF, as in the backend). */
export type StatusBucket = components["schemas"]["StatusBucket"];
export const BUCKETS: readonly StatusBucket[] = ["Completed", "Upcoming", "Offline", "Cancelled"];

export const BUCKET_OF: Record<ScreenStatus, StatusBucket> = {
  Upcoming: "Upcoming",
  "Invitation Email Sent": "Upcoming",
  Shipped: "Upcoming",
  Delivered: "Upcoming",
  "Serviced - Needs More Work": "Upcoming",
  Completed: "Completed",
  Offline: "Offline",
  Archived: "Cancelled",
  Cancelled: "Cancelled",
};

export const bucketOf = (status: ScreenStatus): StatusBucket => BUCKET_OF[status] ?? "Upcoming";

/** `color` for pins and dots; `light` → `dark` is the cluster-bubble scale (few → many). */
export const BUCKET_META: Record<StatusBucket, { color: string; light: string; dark: string; chip: string; members: string }> = {
  Completed: {
    color: "#16a34a", light: "#86efac", dark: "#14532d",
    chip: "bg-emerald-50 text-emerald-700 border-emerald-200", members: "Completed",
  },
  Upcoming: {
    color: "#eab308", light: "#fef08a", dark: "#a16207",
    chip: "bg-yellow-50 text-yellow-800 border-yellow-300",
    members: "Upcoming, Invitation Email Sent, Shipped, Delivered, Serviced - Needs More Work",
  },
  // Not shown for now (not in BUCKETS); kept so the group can come back.
  "In Progress": {
    color: "#7c3aed", light: "#c4b5fd", dark: "#4c1d95",
    chip: "bg-violet-50 text-violet-700 border-violet-200",
    members: "Invitation Email Sent, Shipped, Delivered, Serviced - Needs More Work",
  },
  Offline: {
    color: "#dc2626", light: "#fca5a5", dark: "#7f1d1d",
    chip: "bg-rose-50 text-rose-700 border-rose-200", members: "Offline",
  },
  Cancelled: {
    color: "#64748b", light: "#cbd5e1", dark: "#334155",
    chip: "bg-slate-100 text-slate-600 border-slate-200", members: "Cancelled, Archived",
  },
};

/** The group's colour as text on white (numbers in pins, header bubbles): yellow needs its darker shade to be read. */
export const bucketInk = (bucket: StatusBucket): string => (bucket === "Upcoming" ? "#a16207" : BUCKET_META[bucket].color);

/** How far along the light → dark scale a cluster still takes dark text: further for yellow, which stays pale longer. */
export const darkTextUntil = (bucket: StatusBucket): number => (bucket === "Upcoming" ? 0.7 : 0.35);

/** Cluster counts at which the shade starts (lightest) and saturates (darkest), on a log scale. */
export const SHADE_RANGE = [2, 200] as const;

function mix(from: string, to: string, t: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2].map((i) => Math.round(channel(from, i) + (channel(to, i) - channel(from, i)) * t).toString(16).padStart(2, "0")).join("")}`;
}

/** 0 (few) … 1 (many) on a log scale of `count`. */
export function shadeLevel(count: number): number {
  const [min, max] = SHADE_RANGE;
  return Math.min(1, Math.max(0, Math.log(Math.max(count, min) / min) / Math.log(max / min)));
}

/** A cluster bubble's colour: the group's light shade for a few stores, its dark shade for many. */
export function bucketShade(bucket: StatusBucket, count: number): string {
  const meta = BUCKET_META[bucket];
  return mix(meta.light, meta.dark, shadeLevel(count));
}

export const INSTALL_TYPES = ["Technician", "Self install", "Rep install"] as const;
