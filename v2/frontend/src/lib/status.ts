import type { ScreenStatus } from "@/lib/api/types";

/** One palette for chips, charts and map pins (STORE-MODEL §4.2). Upcoming keeps v1's amber, Completed its green. */
export const STATUS_META: Record<ScreenStatus, { label: string; color: string; chip: string }> = {
  Upcoming: { label: "Upcoming", color: "#d97706", chip: "bg-amber-50 text-amber-700 border-amber-200" },
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
