/** One colour per store tag, shared by the store window's tag control and the stores table's Tag chip, so a tag
 *  reads the same everywhere. The three default tags have fixed colours; any other tag gets a stable colour from a
 *  small palette picked by hashing its name (amber, blue and green are left out, so a custom tag never passes for a
 *  default one, and grey is left out so it never reads as "no tag"). Colour is never the only signal: the tag's name is always shown with it. */

export interface TagTone {
  /** The palette entry's name ("amber", "violet", …), for tests and debugging. */
  key: string;
  /** A small read-only chip (the table, the window for someone who may not set tags). */
  chip: string;
  /** The tag control's trigger in the store window. */
  control: string;
  /** The tag icon beside the name. */
  icon: string;
  /** A solid swatch, beside each option in the tag list. */
  dot: string;
}

// Full class strings, written out, so Tailwind finds them. 800 text on 50/100 backgrounds keeps AA contrast.
const AMBER: TagTone = { key: "amber", chip: "border-amber-300 bg-amber-50 text-amber-900", control: "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100", icon: "text-amber-600", dot: "bg-amber-500" };
const BLUE: TagTone = { key: "blue", chip: "border-blue-200 bg-blue-50 text-blue-800", control: "border-blue-300 bg-blue-50 text-blue-900 hover:bg-blue-100", icon: "text-blue-600", dot: "bg-blue-500" };
const GREEN: TagTone = { key: "green", chip: "border-green-200 bg-green-50 text-green-800", control: "border-green-300 bg-green-50 text-green-900 hover:bg-green-100", icon: "text-green-600", dot: "bg-green-500" };

const PALETTE: TagTone[] = [
  { key: "violet", chip: "border-violet-200 bg-violet-50 text-violet-800", control: "border-violet-300 bg-violet-50 text-violet-900 hover:bg-violet-100", icon: "text-violet-600", dot: "bg-violet-500" },
  { key: "rose", chip: "border-rose-200 bg-rose-50 text-rose-800", control: "border-rose-300 bg-rose-50 text-rose-900 hover:bg-rose-100", icon: "text-rose-600", dot: "bg-rose-500" },
  { key: "teal", chip: "border-teal-200 bg-teal-50 text-teal-800", control: "border-teal-300 bg-teal-50 text-teal-900 hover:bg-teal-100", icon: "text-teal-600", dot: "bg-teal-500" },
  { key: "indigo", chip: "border-indigo-200 bg-indigo-50 text-indigo-800", control: "border-indigo-300 bg-indigo-50 text-indigo-900 hover:bg-indigo-100", icon: "text-indigo-600", dot: "bg-indigo-500" },
  { key: "fuchsia", chip: "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-800", control: "border-fuchsia-300 bg-fuchsia-50 text-fuchsia-900 hover:bg-fuchsia-100", icon: "text-fuchsia-600", dot: "bg-fuchsia-500" },
  { key: "orange", chip: "border-orange-200 bg-orange-50 text-orange-800", control: "border-orange-300 bg-orange-50 text-orange-900 hover:bg-orange-100", icon: "text-orange-600", dot: "bg-orange-500" },
  { key: "cyan", chip: "border-cyan-200 bg-cyan-50 text-cyan-800", control: "border-cyan-300 bg-cyan-50 text-cyan-900 hover:bg-cyan-100", icon: "text-cyan-700", dot: "bg-cyan-500" },
];

/** The default tags (Settings → Store tags), matched however they are capitalised. */
const FIXED: Record<string, TagTone> = { "to do": AMBER, todo: AMBER, "in progress": BLUE, done: GREEN };

const normal = (tag: string) => tag.trim().toLowerCase().replace(/\s+/g, " ");

/** FNV-1a: small, fast and the same in every browser, so a tag keeps its colour across sessions. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

/** The colour of a tag ("" has none: callers show their own "no tag" look). */
export function tagTone(tag: string): TagTone {
  const name = normal(tag);
  return FIXED[name] ?? PALETTE[hash(name) % PALETTE.length]!;
}

/** The read-only chip's classes for a tag. */
export const tagChip = (tag: string) => `rounded-full border px-2 py-0.5 text-xs font-medium ${tagTone(tag).chip}`;
