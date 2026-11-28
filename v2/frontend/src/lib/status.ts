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
  "Not Registered": { label: "Not Registered", color: "#7c3aed", chip: "bg-violet-50 text-violet-700 border-violet-200" },
  Archived: { label: "Archived", color: "#64748b", chip: "bg-slate-100 text-slate-600 border-slate-200" },
  Cancelled: { label: "Cancelled", color: "#3f3f46", chip: "bg-zinc-100 text-zinc-700 border-zinc-300" },
};

export const INSTALLER_COLORS = ["#034EA1", "#009dda", "#7c3aed", "#dc2626", "#16a34a", "#ea580c", "#ca8a04"];

export const PROJECT_TYPE_LABELS: Record<string, string> = {
  new_installation: "New Installation",
  offline: "Offline",
  new_installation_and_offline: "New Installation + Offline",
};

/** The groups the UI shows (backend `StatusBucket`): KPI bubbles, filter chips, map pins and cluster bubbles.
 *  Stored statuses keep all ten. Not Registered (the CMS has the device, it never registered), Cancelled (never
 *  registered a screen) and Archived (ran for a while, then archived) are groups of their own. In Progress is not shown for now: its statuses count as
 *  Upcoming (to bring it back, add it to BUCKETS and point them at it in BUCKET_OF, as in the backend). */
export type StatusBucket = components["schemas"]["StatusBucket"];
export const BUCKETS: readonly StatusBucket[] = ["Completed", "Upcoming", "Offline", "Not Registered", "Cancelled", "Archived"];
/** The order of the map's tags. */
export const MAP_BUCKETS: readonly StatusBucket[] = ["Upcoming", "Completed", "Offline", "Archived", "Cancelled", "Not Registered"];

export const BUCKET_OF: Record<ScreenStatus, StatusBucket> = {
  Upcoming: "Upcoming",
  "Invitation Email Sent": "Upcoming",
  Shipped: "Upcoming",
  Delivered: "Upcoming",
  "Serviced - Needs More Work": "Upcoming",
  Completed: "Completed",
  Offline: "Offline",
  "Not Registered": "Not Registered",
  Archived: "Archived",
  Cancelled: "Cancelled",
};

export const bucketOf = (status: ScreenStatus): StatusBucket => BUCKET_OF[status] ?? "Upcoming";

/** Not Registered is a screen's status. A store is never "not registered": one whose least-progressed screen is
 *  reads In Progress, in the lists, the store filters and the map's Locations count (backend `STORE_BUCKET_OF`). */
export const STORE_BUCKETS: readonly StatusBucket[] = BUCKETS.map((bucket) => (bucket === "Not Registered" ? "In Progress" : bucket));
export const storeBucketOf = (status: ScreenStatus): StatusBucket => (status === "Not Registered" ? "In Progress" : bucketOf(status));
export const storeStatusLabel = (status: ScreenStatus): string => (status === "Not Registered" ? "In Progress" : STATUS_META[status].label);

/** `color` for pins and dots; `light` → `dark` is the cluster-bubble scale (few → many). */
/** What a group is called on screen. The Completed group reads "Online": its screens are the ones reporting, and
 *  the header's Completed is online + offline together. */
export const BUCKET_LABEL: Record<StatusBucket, string> = {
  Completed: "Online",
  Upcoming: "Upcoming",
  "In Progress": "In Progress",
  Offline: "Offline",
  "Not Registered": "Not Registered",
  Cancelled: "Cancelled",
  Archived: "Archived",
};

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
  // Stores only, in Not Registered's colour: the store's side of the same thing.
  "In Progress": {
    color: "#7c3aed", light: "#c4b5fd", dark: "#4c1d95",
    chip: "bg-violet-50 text-violet-700 border-violet-200",
    members: "In Progress: a screen is in the Dolphin data but has not registered yet",
  },
  Offline: {
    color: "#dc2626", light: "#fca5a5", dark: "#7f1d1d",
    chip: "bg-rose-50 text-rose-700 border-rose-200", members: "Offline",
  },
  "Not Registered": {
    color: "#7c3aed", light: "#c4b5fd", dark: "#4c1d95",
    chip: "bg-violet-50 text-violet-700 border-violet-200", members: "Not Registered: in the Dolphin data, never registered",
  },
  Cancelled: {
    color: "#3f3f46", light: "#a1a1aa", dark: "#18181b",
    chip: "bg-zinc-100 text-zinc-700 border-zinc-300", members: "Cancelled: never registered a screen",
  },
  Archived: {
    color: "#64748b", light: "#cbd5e1", dark: "#334155",
    chip: "bg-slate-100 text-slate-600 border-slate-200", members: "Archived: ran for a while, then archived",
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
