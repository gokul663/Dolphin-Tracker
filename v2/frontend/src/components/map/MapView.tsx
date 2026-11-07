import { useEffect, useMemo, useRef, useState } from "react";
import { APIProvider, InfoWindow, Map, useMap } from "@vis.gl/react-google-maps";
import { MarkerClusterer, SuperClusterAlgorithm, type Cluster, type Renderer } from "@googlemaps/markerclusterer";
import { MapPinOff } from "lucide-react";
import {
  boundsOf,
  changedStyles,
  filterByStatus,
  groupPins,
  locationSignature,
  type MapUnit,
  markerStyles,
  markerSvg,
  markerZIndex,
  OVERLAY_COLORS,
  statusCounts,
  toggleStatus,
  type Bounds,
  type MarkerStyle,
  type PinGroup,
} from "@/components/map/pins";
import { useMapsConfig } from "@/features/places/api";
import { STOP_STATUSES, type Pin, type StopStatus } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";
import { cn } from "@/lib/utils";

/** Clusters form at this zoom and below; closer in, every location gets its own pin. */
export const CLUSTER_MAX_ZOOM = 11;
const US_CENTER = { lat: 39.5, lng: -98.35 };
/** Cluster density scale: sky → blue → navy (no status uses these shades) on a log scale of the cluster's store count, saturating at the top tick. */
const DENSITY_STOPS = ["#bae6fd", "#3b82f6", "#1e3a8a"] as const;
export const DENSITY_TICKS = [2, 10, 50, 200] as const;
const DENSITY_GRADIENT = `linear-gradient(to right, ${DENSITY_STOPS.join(", ")})`;

function mix(from: string, to: string, t: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2].map((i) => Math.round(channel(from, i) + (channel(to, i) - channel(from, i)) * t).toString(16).padStart(2, "0")).join("")}`;
}

/** Colour for a cluster of `count` stores. */
export function densityColor(count: number): string {
  const min = DENSITY_TICKS[0];
  const max = DENSITY_TICKS[DENSITY_TICKS.length - 1];
  const t = Math.min(1, Math.max(0, Math.log(Math.max(count, min) / min) / Math.log(max / min)));
  return t < 0.5 ? mix(DENSITY_STOPS[0], DENSITY_STOPS[1], t * 2) : mix(DENSITY_STOPS[1], DENSITY_STOPS[2], (t - 0.5) * 2);
}

/** Cluster size in px grows with the log of its store count. */
export function clusterSize(count: number): number {
  return Math.round(Math.min(56, 26 + Math.log10(Math.max(count, 1)) * 14));
}

/** What each marker stands for in cluster totals: its stores, or its screens in the Screens view. */
const markerWeight = new WeakMap<object, number>();

const clusterRenderer: Renderer = {
  render: ({ markers, position }: Cluster) => {
    const count = (markers ?? []).reduce((sum, marker) => sum + (markerWeight.get(marker) ?? 1), 0);
    const size = clusterSize(count);
    const color = densityColor(count);
    const text = count < 10 ? "#0c4a6e" : "#fff"; // dark text on the light end
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 1}" fill="${color}" fill-opacity="0.3"/><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 6}" fill="${color}" stroke="#fff" stroke-width="2"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" fill="${text}" font-family="sans-serif" font-size="11" font-weight="700">${count}</text></svg>`;
    return new google.maps.Marker({
      position,
      icon: { url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`, scaledSize: new google.maps.Size(size, size), anchor: new google.maps.Point(size / 2, size / 2) },
      title: `${count} stores`,
      zIndex: Number(google.maps.Marker.MAX_ZINDEX) + count,
    });
  },
};

export interface MapViewProps {
  pins: Pin[];
  selectedId?: string | null;
  hoveredId?: string | null;
  onSelect?: (uid: string) => void;
  /** Fires once a pan/zoom settles (`idle`), not on every frame; the Stores tab uses it for "only stores in view". */
  onBoundsChange?: (bounds: Bounds) => void;
  className?: string;
  /** Count locations (stores) or screens: legend totals, the number in a pin and cluster totals follow it. */
  unit?: MapUnit;
}

/** Shared map for the Stores and Routes tabs: status pins, same-location stacks, legend, clustering, sync. */
export function MapView({ pins, selectedId, hoveredId, onSelect, onBoundsChange, className, unit = "locations" }: MapViewProps) {
  const config = useMapsConfig();
  const [active, setActive] = useState<Set<StopStatus>>(new Set());
  const visible = useMemo(() => filterByStatus(pins, active, unit), [pins, active, unit]);
  const groups = useMemo(() => groupPins(visible), [visible]);
  const fitSignature = useMemo(() => locationSignature(groupPins(pins)), [pins]);
  const counts = statusCounts(pins, unit);
  // Only statuses that have stores get a legend entry, matching the project KPI cards.
  const present = STOP_STATUSES.filter((status) => counts[status] > 0);
  const toggle = (current: Set<StopStatus>, status: StopStatus) => {
    const next = toggleStatus(current, present, status);
    return next.size === present.length ? new Set<StopStatus>() : next; // all on = no filter, so new statuses still show
  };
  const showBadges = pins.some((pin) => pin.route_plan_id || (pin.visit_state && pin.visit_state !== "none"));
  const stacked = groups.filter((group) => group.pins.length > 1);
  const key = config.data?.google_maps_browser_key ?? "";
  const mapId = config.data?.google_map_id || undefined; // a vector map when the user has created a Map ID

  return (
    <div className={cn("flex min-h-[360px] flex-col overflow-hidden rounded-xl border bg-white", className)}>
      <div className="space-y-2 border-b p-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-slate-50 px-3 py-2.5" role="group" aria-label="Map legend">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-medium text-slate-600">Status:</span>
            {present.map((status) => {
              const on = active.size === 0 || active.has(status);
              return (
                <button
                  key={status}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setActive((current) => toggle(current, status))}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium",
                    on ? "border-slate-200 bg-white text-slate-700 shadow-sm" : "border-transparent bg-slate-100 text-slate-400 line-through",
                  )}
                  title={`Toggle ${STATUS_META[status].label} pins`}
                >
                  <span className="size-3 rounded-full" style={{ background: on ? STATUS_META[status].color : "#cbd5e1" }} />
                  {STATUS_META[status].label} <span className="tabular-nums text-slate-500">{counts[status]}</span>
                </button>
              );
            })}
            {present.length === 0 && <span className="text-xs text-slate-400">No stores</span>}
          </div>
          {showBadges && (
            <>
              <span className="hidden h-6 w-px bg-slate-200 sm:block" aria-hidden />
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600" aria-label="Marker badges">
                <span className="font-medium">Badges:</span>
                <LegendDot color={OVERLAY_COLORS.route} label="In route" />
                <LegendDot color={OVERLAY_COLORS.visited} label="Visited" />
                <LegendDot color={OVERLAY_COLORS.partly} label="Partly visited" />
              </div>
            </>
          )}
          <span className="hidden h-6 w-px bg-slate-200 sm:block" aria-hidden />
          <div className="flex items-center gap-2 text-xs text-slate-600" aria-label="Clusters">
            <span className="font-medium">Clusters:</span>
            <div className="flex flex-col gap-0.5">
              <span className="h-2.5 w-36 rounded-full" style={{ background: DENSITY_GRADIENT }} />
              <span className="flex w-36 justify-between font-mono text-[10px] text-slate-500">
                {DENSITY_TICKS.map((tick, i) => (
                  <span key={tick}>{i === DENSITY_TICKS.length - 1 ? `${tick}+` : tick}</span>
                ))}
              </span>
            </div>
            <span className="text-slate-500">stores</span>
          </div>
        </div>
        <div className="text-right font-mono text-[10px] text-slate-500" aria-live="polite">
          {unit === "screens" ? `${groups.reduce((sum, group) => sum + group.screens, 0)} screens · ` : ""}
          {visible.length} records · {groups.length} pins
          {stacked.length ? ` · ${stacked.reduce((sum, group) => sum + group.pins.length, 0)} at ${stacked.length} shared addresses` : ""}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {config.isPending ? (
          <MapMessage text="Loading map…" />
        ) : !key ? (
          <MapMessage text="Map unavailable: no Google Maps browser key is configured (DT_GOOGLE_BROWSER_KEY)." />
        ) : (
          <APIProvider apiKey={key}>
            <Map
              mapId={mapId}
              defaultCenter={US_CENTER}
              defaultZoom={4}
              gestureHandling="greedy"
              mapTypeControl={false}
              streetViewControl={false}
              className="absolute inset-0"
              onIdle={(event) => {
                const bounds = event.map.getBounds()?.toJSON();
                if (bounds) onBoundsChange?.(bounds);
              }}
            >
              <Markers groups={groups} fitSignature={fitSignature} selectedId={selectedId} hoveredId={hoveredId} onSelect={onSelect} unit={unit} />
            </Map>
          </APIProvider>
        )}
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="size-3 rounded-full ring-2 ring-white" style={{ background: color }} /> {label}
    </span>
  );
}

function MapMessage({ text }: { text: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-50 p-6 text-center text-sm text-slate-500">
      <MapPinOff className="size-6 text-slate-400" />
      {text}
    </div>
  );
}

interface MarkersProps {
  groups: PinGroup[];
  /** Location signature over every pin (before the legend filter): the map refits only when it changes. */
  fitSignature: string;
  selectedId?: string | null;
  hoveredId?: string | null;
  onSelect?: (uid: string) => void;
  unit: MapUnit;
}

/** Imperative markers (one per location) in a clusterer that only clusters at low zoom. */
function Markers({ groups, fitSignature, selectedId, hoveredId, onSelect, unit }: MarkersProps) {
  const map = useMap();
  const clusterer = useRef<MarkerClusterer | null>(null);
  const markers = useRef(new globalThis.Map<string, google.maps.Marker>()); // by location key
  const applied = useRef(new globalThis.Map<string, MarkerStyle>()); // the style each marker has now
  const latest = useRef(new globalThis.Map<string, PinGroup>()); // click handlers read the current group
  latest.current = new globalThis.Map(groups.map((group) => [group.key, group]));
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const openGroup = openKey ? latest.current.get(openKey) ?? null : null;

  useEffect(() => {
    if (!map) return;
    clusterer.current = new MarkerClusterer({
      map,
      algorithm: new SuperClusterAlgorithm({ maxZoom: CLUSTER_MAX_ZOOM, radius: 60 }),
      renderer: clusterRenderer,
    });
    return () => {
      clusterer.current?.clearMarkers();
      clusterer.current?.setMap(null);
      clusterer.current = null;
    };
  }, [map]);

  // Rebuild markers only when the set of visible locations changes; styling is the next effect's job.
  const signature = locationSignature(groups);
  useEffect(() => {
    if (!map || !clusterer.current) return;
    clusterer.current.clearMarkers();
    markers.current.clear();
    applied.current.clear();
    const created = groups.map((group) => {
      const marker = new google.maps.Marker({ position: { lat: group.lat, lng: group.lng } });
      marker.addListener("click", () => {
        const current = latest.current.get(group.key);
        if (!current) return;
        if (current.pins.length === 1 && current.pins[0]) onSelectRef.current?.(current.pins[0].uid);
        else setOpenKey(current.key);
      });
      markers.current.set(group.key, marker);
      return marker;
    });
    clusterer.current.addMarkers(created);
  }, [map, signature]); // `signature` stands in for `groups`: rebuild only when locations change

  // Fit to the project's locations (v1: one pin → zoom 13) only when those change, not on legend toggles.
  const fitGroups = useRef(groups);
  fitGroups.current = groups;
  useEffect(() => {
    if (!map) return;
    const bounds = boundsOf(fitGroups.current);
    if (!bounds) {
      map.setCenter(US_CENTER);
      map.setZoom(4);
    } else if (fitGroups.current.length === 1) {
      map.setCenter({ lat: bounds.north, lng: bounds.east });
      map.setZoom(13);
    } else {
      map.fitBounds(bounds, 54);
    }
  }, [map, fitSignature]);

  // Status, stack count, selection and hover restyle only the markers whose style changed. Never refits.
  useEffect(() => {
    const next = markerStyles(groups, selectedId, hoveredId, unit);
    const changed = changedStyles(applied.current, next);
    for (const key of changed) {
      const marker = markers.current.get(key);
      const style = next.get(key);
      if (!marker || !style) continue;
      const group = latest.current.get(key);
      marker.setIcon(icon(style));
      marker.setZIndex(markerZIndex(style));
      const name = group?.pins[0]?.store_name ?? "";
      marker.setTitle(
        unit === "screens" ? `${name}${(group?.pins.length ?? 1) > 1 ? ` +${(group?.pins.length ?? 1) - 1} more` : ""} · ${style.count} screens`
          : style.count > 1 ? `${style.count} locations` : name,
      );
      markerWeight.set(marker, style.count);
      applied.current.set(key, style);
    }
    if (changed.length) clusterer.current?.render(); // cluster totals follow the new weights
  });

  // A newly selected store off-screen is panned into view.
  useEffect(() => {
    const group = selectedId ? groups.find((item) => item.pins.some((pin) => pin.uid === selectedId)) : undefined;
    const position = group && markers.current.get(group.key)?.getPosition();
    if (map && position && !map.getBounds()?.contains(position)) map.panTo(position);
  }, [map, selectedId]); // only when the selection changes

  if (!openGroup) return null;
  return (
    <InfoWindow position={{ lat: openGroup.lat, lng: openGroup.lng }} onCloseClick={() => setOpenKey(null)}>
      <div className="max-w-64 space-y-1 text-sm">
        <div className="font-semibold">{openGroup.pins.length} locations at this address</div>
        <ul className="max-h-48 space-y-1 overflow-y-auto">
          {openGroup.pins.map((pin, index) => (
            <li key={pin.uid}>
              <button
                type="button"
                className="text-left hover:underline"
                onClick={() => {
                  onSelect?.(pin.uid);
                  setOpenKey(null);
                }}
              >
                <b>
                  {index + 1}. {pin.store_name}
                </b>{" "}
                <span className="text-slate-500">
                  {pin.installer ? `${pin.installer} · Day ${pin.day} · ` : ""}
                </span>
                <span style={{ color: STATUS_META[pin.status].color, fontWeight: 700 }}>{STATUS_META[pin.status].label}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </InfoWindow>
  );
}

function icon({ status, count, emphasis, overlay }: MarkerStyle): google.maps.Icon {
  const scale = emphasis === "normal" ? 1 : 1.2;
  return {
    url: markerSvg(status, count, emphasis, overlay),
    scaledSize: new google.maps.Size(40 * scale, 50 * scale),
    anchor: new google.maps.Point(20 * scale, 47 * scale),
  };
}
