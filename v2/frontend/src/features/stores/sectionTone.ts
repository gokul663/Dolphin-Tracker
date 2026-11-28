import {
  FileSpreadsheet,
  Hammer,
  HardHat,
  Images,
  ListChecks,
  MapPin,
  Monitor,
  NotebookPen,
  Receipt,
  StickyNote,
  Store,
  Users,
  Wifi,
  Wrench,
  type LucideIcon,
} from "lucide-react";

/** The store window's quiet colour per section and summary card: one hue each, so the window reads as organised
 *  rather than all white and slate. Related sections share a hue (notes with site notes, the installation with the
 *  mounts, the contacts with who installs), which keeps the palette to a handful of light tints. Text stays dark on
 *  every tint (700–900 on 50/100, AA), the icon and title always come with the colour, and inputs are never tinted. */

export interface SectionTone {
  /** The small icon chip in the header. */
  chip: string;
  /** The header strip's tint, and its hover. */
  header: string;
  /** The title (the mono micro-label). */
  title: string;
  /** The summary on the header's right ("3 of 7 filled"). */
  summary: string;
  /** The line between the header and the body. */
  line: string;
  /** A key value worth a light pill of the same hue (the WiFi network name). */
  value: string;
}

// Full class strings, written out, so Tailwind finds them.
const HUES = {
  brand: { chip: "bg-brand/10 text-brand", header: "bg-brand/[0.04] hover:bg-brand/[0.07]", title: "text-brand-strong", summary: "text-brand", line: "border-brand/10", value: "bg-brand/10 text-brand-strong" },
  sky: { chip: "bg-sky-100 text-sky-700", header: "bg-sky-50/60 hover:bg-sky-50", title: "text-sky-900", summary: "text-sky-700", line: "border-sky-100", value: "bg-sky-50 text-sky-900" },
  amber: { chip: "bg-amber-100 text-amber-700", header: "bg-amber-50/60 hover:bg-amber-50", title: "text-amber-900", summary: "text-amber-700", line: "border-amber-100", value: "bg-amber-50 text-amber-900" },
  rose: { chip: "bg-rose-100 text-rose-700", header: "bg-rose-50/60 hover:bg-rose-50", title: "text-rose-900", summary: "text-rose-700", line: "border-rose-100", value: "bg-rose-50 text-rose-900" },
  emerald: { chip: "bg-emerald-100 text-emerald-700", header: "bg-emerald-50/60 hover:bg-emerald-50", title: "text-emerald-900", summary: "text-emerald-700", line: "border-emerald-100", value: "bg-emerald-50 text-emerald-900" },
  violet: { chip: "bg-violet-100 text-violet-700", header: "bg-violet-50/60 hover:bg-violet-50", title: "text-violet-900", summary: "text-violet-700", line: "border-violet-100", value: "bg-violet-50 text-violet-900" },
  indigo: { chip: "bg-indigo-100 text-indigo-700", header: "bg-indigo-50/60 hover:bg-indigo-50", title: "text-indigo-900", summary: "text-indigo-700", line: "border-indigo-100", value: "bg-indigo-50 text-indigo-900" },
  orange: { chip: "bg-orange-100 text-orange-700", header: "bg-orange-50/60 hover:bg-orange-50", title: "text-orange-900", summary: "text-orange-700", line: "border-orange-100", value: "bg-orange-50 text-orange-900" },
  slate: { chip: "bg-slate-100 text-slate-600", header: "bg-slate-50/70 hover:bg-slate-100/70", title: "text-slate-700", summary: "text-slate-600", line: "border-slate-100", value: "bg-slate-100 text-slate-900" },
} satisfies Record<string, SectionTone>;

/** Every section and summary card of the store window, with its hue and icon. The one place to change either. */
export const SECTION_TONE = {
  // The window's own sections (the CMS data comparison keeps its own cyan panel, DEVICE_TONE).
  "Identity & address": { ...HUES.brand, icon: Store },
  Screens: { ...HUES.sky, icon: Monitor },
  Notes: { ...HUES.amber, icon: StickyNote },
  Pictures: { ...HUES.rose, icon: Images },
  Location: { ...HUES.emerald, icon: MapPin },
  WiFi: { ...HUES.violet, icon: Wifi },
  Contacts: { ...HUES.indigo, icon: Users },
  Installation: { ...HUES.orange, icon: Hammer },
  "Site notes": { ...HUES.amber, icon: NotebookPen },
  "Site checklist": { ...HUES.emerald, icon: ListChecks },
  "Other imported data": { ...HUES.slate, icon: FileSpreadsheet },
  // The summary cards on top (the Screens card shares the Screens section's sky).
  "Hardware cost": { ...HUES.sky, icon: Receipt },
  Mounts: { ...HUES.orange, icon: Wrench },
  "Installed by": { ...HUES.indigo, icon: HardHat },
} satisfies Record<string, SectionTone & { icon: LucideIcon }>;

export type ToneName = keyof typeof SECTION_TONE;
