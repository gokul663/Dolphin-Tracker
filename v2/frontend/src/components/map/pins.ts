/** Pure helpers behind MapView: same-location stacking, status colours, legend counts, bounds. */
import type { Pin, StopStatus } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";

export interface PinGroup {
  key: string;
  lat: number;
  lng: number;
  pins: Pin[];
  /** One status when every record agrees, otherwise "Other" (v1 behaviour). */
  status: StopStatus;
}

/** v1 `locationIdentity`: records at the same point (6 decimals ≈ 10 cm) share one pin with a count. */
export function locationKey(pin: Pick<Pin, "lat" | "lng">): string {
  return `${pin.lat.toFixed(6)}|${pin.lng.toFixed(6)}`;
}

export function groupPins(pins: Pin[]): PinGroup[] {
  const groups = new Map<string, Pin[]>();
  for (const pin of pins) {
    if (!Number.isFinite(pin.lat) || !Number.isFinite(pin.lng)) continue;
    const key = locationKey(pin);
    const list = groups.get(key);
    if (list) list.push(pin);
    else groups.set(key, [pin]);
  }
  return [...groups].map(([key, members]) => {
    const statuses = new Set(members.map((pin) => pin.status));
    const first = members[0] as Pin;
    return { key, lat: first.lat, lng: first.lng, pins: members, status: statuses.size === 1 ? first.status : "Other" };
  });
}

export function filterByStatus(pins: Pin[], active: ReadonlySet<StopStatus>): Pin[] {
  return active.size === 0 ? pins : pins.filter((pin) => active.has(pin.status));
}

export function statusCounts(pins: Pin[]): Record<StopStatus, number> {
  const counts: Record<StopStatus, number> = { Complete: 0, Incomplete: 0, "Technical Issue": 0, Other: 0 };
  for (const pin of pins) counts[pin.status] += 1;
  return counts;
}

/** v1 legend toggle: switching off the last visible status turns every status back on. */
export function toggleStatus(active: ReadonlySet<StopStatus>, all: readonly StopStatus[], status: StopStatus): Set<StopStatus> {
  const current = new Set(active.size === 0 ? all : active);
  if (current.has(status)) {
    if (current.size === 1) return new Set(all);
    current.delete(status);
  } else current.add(status);
  return current;
}

export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export function boundsOf(points: { lat: number; lng: number }[]): Bounds | null {
  if (!points.length) return null;
  const lats = points.map((point) => point.lat);
  const lngs = points.map((point) => point.lng);
  return { north: Math.max(...lats), south: Math.min(...lats), east: Math.max(...lngs), west: Math.min(...lngs) };
}

export function inBounds(point: { lat: number; lng: number }, bounds: Bounds): boolean {
  const inLng = bounds.west <= bounds.east
    ? point.lng >= bounds.west && point.lng <= bounds.east
    : point.lng >= bounds.west || point.lng <= bounds.east; // crosses the antimeridian
  return point.lat >= bounds.south && point.lat <= bounds.north && inLng;
}

/** v1 `projectMarkerIcon`: a status-coloured pin with the stack count in its head. */
export function markerSvg(status: StopStatus, count = 1, emphasis: "normal" | "hover" | "selected" = "normal"): string {
  const color = STATUS_META[status].color;
  const label = count > 1 ? (count > 99 ? "99+" : String(count)) : "";
  const ring = emphasis === "selected" ? "#0f172a" : emphasis === "hover" ? "#0891b2" : "#ffffff";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="50" viewBox="0 0 40 50">` +
    `<path fill="${color}" stroke="${ring}" stroke-width="3" d="M20 3C11.2 3 4 10.2 4 19c0 11.8 16 28 16 28s16-16.2 16-28C36 10.2 28.8 3 20 3z"/>` +
    `<circle cx="20" cy="19" r="${count > 1 ? 10 : 6}" fill="#ffffff"/>` +
    `<text x="20" y="${count > 99 ? 22 : 23}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${count > 99 ? 8 : 12}" font-weight="800" fill="${color}">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

export type Emphasis = "normal" | "hover" | "selected";

/**
 * Which markers exist: one per location key. Status, stack count and emphasis are styling, so an optimistic
 * recolour never rebuilds the markers. The map fits its bounds only when the signature over *all* pins changes
 * (a new project or an import), never on a legend toggle, a status change or a hover.
 */
export function locationSignature(groups: Pick<PinGroup, "key">[]): string {
  return groups.map((group) => group.key).join(",");
}

export interface MarkerStyle {
  status: StopStatus;
  count: number;
  emphasis: Emphasis;
}

/** The style every marker should have now, keyed by location key. */
export function markerStyles(groups: PinGroup[], selectedId?: string | null, hoveredId?: string | null): Map<string, MarkerStyle> {
  const styles = new Map<string, MarkerStyle>();
  for (const group of groups) {
    const has = (uid?: string | null) => Boolean(uid) && group.pins.some((pin) => pin.uid === uid);
    const emphasis: Emphasis = has(selectedId) ? "selected" : has(hoveredId) ? "hover" : "normal";
    styles.set(group.key, { status: group.status, count: group.pins.length, emphasis });
  }
  return styles;
}

/** Location keys whose style differs between two `markerStyles` results (new keys included): restyle only these. */
export function changedStyles(previous: ReadonlyMap<string, MarkerStyle>, next: ReadonlyMap<string, MarkerStyle>): string[] {
  const changed: string[] = [];
  for (const [key, style] of next) {
    const before = previous.get(key);
    if (!before || before.status !== style.status || before.count !== style.count || before.emphasis !== style.emphasis) {
      changed.push(key);
    }
  }
  return changed;
}

export function markerZIndex(style: MarkerStyle): number {
  if (style.emphasis !== "normal") return 5000;
  return style.count > 1 ? 1000 + style.count : 1;
}
