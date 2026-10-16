import type { StopStatus } from "@/lib/api/types";

/** The v1 legacy planner's STATUS_MAP: one palette for chips, charts and map pins. "Incomplete" reads "Upcoming". */
export const STATUS_META: Record<StopStatus, { label: string; color: string; chip: string }> = {
  Complete: { label: "Complete", color: "#16a34a", chip: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  Incomplete: { label: "Upcoming", color: "#d97706", chip: "bg-amber-50 text-amber-700 border-amber-200" },
  "Technical Issue": { label: "Technical Issue", color: "#dc2626", chip: "bg-rose-50 text-rose-700 border-rose-200" },
  Other: { label: "Other", color: "#7c3aed", chip: "bg-violet-50 text-violet-700 border-violet-200" },
};

export const INSTALLER_COLORS = ["#0F5B7C", "#0891b2", "#7c3aed", "#dc2626", "#16a34a", "#ea580c", "#ca8a04"];

export const PROJECT_TYPE_LABELS: Record<string, string> = {
  new_installation: "New Installation",
  offline: "Offline",
  new_installation_and_offline: "New Installation + Offline",
};
