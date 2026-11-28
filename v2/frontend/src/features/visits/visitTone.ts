import {
  ClipboardList,
  FileSpreadsheet,
  Hammer,
  Images,
  ListChecks,
  MapPin,
  MessageSquareText,
  Monitor,
  MonitorCog,
  NotebookPen,
  Package,
  Phone,
  Store,
  UserRound,
  Wifi,
  type LucideIcon,
} from "lucide-react";

/** The visit window's quiet colour per section, in the store window's hues (stores/sectionTone.ts) so the two
 *  windows read as one system: the screen sky, pictures rose, network and WiFi violet, people indigo, notes amber,
 *  the checklist and the map emerald, what to bring orange, the store itself brand, the software checks and the issue
 *  slate. Text stays 700–900 on 50/100 tints (AA); inputs are never tinted. */

export interface VisitTone {
  chip: string;
  /** A header strip's tint (no hover: most strips are not buttons). */
  strip: string;
  /** The hover of a strip that is a button (Inventory, Store comment). */
  hover: string;
  title: string;
  summary: string;
  line: string;
}

// Full class strings, written out, so Tailwind finds them. The same strings as sectionTone.ts.
const HUES = {
  brand: { chip: "bg-brand/10 text-brand", strip: "bg-brand/[0.04]", hover: "hover:bg-brand/[0.07]", title: "text-brand-strong", summary: "text-brand", line: "border-brand/10" },
  sky: { chip: "bg-sky-100 text-sky-700", strip: "bg-sky-50/60", hover: "hover:bg-sky-50", title: "text-sky-900", summary: "text-sky-700", line: "border-sky-100" },
  amber: { chip: "bg-amber-100 text-amber-700", strip: "bg-amber-50/60", hover: "hover:bg-amber-50", title: "text-amber-900", summary: "text-amber-700", line: "border-amber-100" },
  rose: { chip: "bg-rose-100 text-rose-700", strip: "bg-rose-50/60", hover: "hover:bg-rose-50", title: "text-rose-900", summary: "text-rose-700", line: "border-rose-100" },
  emerald: { chip: "bg-emerald-100 text-emerald-700", strip: "bg-emerald-50/60", hover: "hover:bg-emerald-50", title: "text-emerald-900", summary: "text-emerald-700", line: "border-emerald-100" },
  violet: { chip: "bg-violet-100 text-violet-700", strip: "bg-violet-50/60", hover: "hover:bg-violet-50", title: "text-violet-900", summary: "text-violet-700", line: "border-violet-100" },
  indigo: { chip: "bg-indigo-100 text-indigo-700", strip: "bg-indigo-50/60", hover: "hover:bg-indigo-50", title: "text-indigo-900", summary: "text-indigo-700", line: "border-indigo-100" },
  orange: { chip: "bg-orange-100 text-orange-700", strip: "bg-orange-50/60", hover: "hover:bg-orange-50", title: "text-orange-900", summary: "text-orange-700", line: "border-orange-100" },
  slate: { chip: "bg-slate-100 text-slate-600", strip: "bg-slate-50/70", hover: "hover:bg-slate-100/70", title: "text-slate-700", summary: "text-slate-600", line: "border-slate-100" },
} satisfies Record<string, VisitTone>;

/** Every section of the visit window, with its hue and icon. The one place to change either. */
export const VISIT_TONE = {
  Inventory: { ...HUES.orange, icon: Package },
  Screens: { ...HUES.sky, icon: Monitor },
  "The screen": { ...HUES.sky, icon: Monitor },
  Pictures: { ...HUES.rose, icon: Images },
  Network: { ...HUES.violet, icon: Wifi },
  Software: { ...HUES.slate, icon: MonitorCog },
  Issue: { ...HUES.slate, icon: ClipboardList },
  Location: { ...HUES.emerald, icon: MapPin },
  "Store comment": { ...HUES.amber, icon: MessageSquareText },
  Store: { ...HUES.brand, icon: Store },
  "Store WiFi": { ...HUES.violet, icon: Wifi },
  Owner: { ...HUES.indigo, icon: UserRound },
  "Store Contact": { ...HUES.indigo, icon: Phone },
  // The sheet's groups, in the store window's hues for the same names.
  "Site notes": { ...HUES.amber, icon: NotebookPen },
  "Site checklist": { ...HUES.emerald, icon: ListChecks },
  Installation: { ...HUES.orange, icon: Hammer },
  "Identity & address": { ...HUES.brand, icon: Store },
  "Other imported data": { ...HUES.slate, icon: FileSpreadsheet },
} satisfies Record<string, VisitTone & { icon: LucideIcon }>;

export type VisitToneName = keyof typeof VISIT_TONE;
