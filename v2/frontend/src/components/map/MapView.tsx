import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { APIProvider, InfoWindow, Map, useMap } from "@vis.gl/react-google-maps";
import { MarkerClusterer, SuperClusterAlgorithm, type Cluster, type Renderer } from "@googlemaps/markerclusterer";
import { MapPinOff } from "lucide-react";
import {
  boundsOf,
  bucketCounts,
  changedStyles,
  clusterSignature,
  groupPins,
  locationSignature,
  type MapUnit,
  markerStyles,
  markerSvg,
  markerZIndex,
  OVERLAY_COLORS,
  type Bounds,
  type MarkerStyle,
  type PinGroup,
} from "@/components/map/pins";
import { useMapsConfig } from "@/features/places/api";
import type { Pin } from "@/lib/api/types";
import { BUCKET_META, BUCKETS, bucketOf, bucketShade, darkTextUntil, shadeLevel, STATUS_META, type StatusBucket } from "@/lib/status";
import { cn } from "@/lib/utils";

/** Clusters form at this zoom and below; closer in, every location gets its own pin. */
export const CLUSTER_MAX_ZOOM = 11;
const US_CENTER = { lat: 39.5, lng: -98.35 };
/** Cluster size in px grows with the log of its store count. */
export function clusterSize(count: number): number {
  return Math.round(Math.min(56, 26 + Math.log10(Math.max(count, 1)) * 14));
}

/** What each marker stands for in cluster totals: its stores, or its screens in the Screens view. */
const markerWeight = new WeakMap<object, number>();

/** One bubble per status group: the group's colour, light for a few stores and dark for many. Bubbles of
 *  different groups around the same spot fan out a little so each stays readable. */
export function clusterRenderer(bucket: StatusBucket): Renderer {
  const index = BUCKETS.indexOf(bucket);
  return {
    render: ({ markers, position }: Cluster) => {
      const count = (markers ?? []).reduce((sum, marker) => sum + (markerWeight.get(marker) ?? 1), 0);
      const size = clusterSize(count);
      const color = bucketShade(bucket, count);
      const text = shadeLevel(count) < darkTextUntil(bucket) ? BUCKET_META[bucket].dark : "#fff"; // dark text on the light end
      const angle = (index * 2 * Math.PI) / BUCKETS.length - Math.PI / 2;
      const dx = Math.cos(angle) * size * 0.3;
      const dy = Math.sin(angle) * size * 0.3;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 1}" fill="${color}" fill-opacity="0.3"/><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 6}" fill="${color}" stroke="#fff" stroke-width="2"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" fill="${text}" font-family="sans-serif" font-size="11" font-weight="700">${count}</text></svg>`;
      return new google.maps.Marker({
        position,
        icon: {
          url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
          scaledSize: new google.maps.Size(size, size),
          anchor: new google.maps.Point(size / 2 - dx, size / 2 - dy),
        },
        title: `${count} ${bucket}`,
        zIndex: Number(google.maps.Marker.MAX_ZINDEX) + count,
      });
    },
  };
}

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
  /** In the map's header bar, before the legend (the Stores tab's Locations / Screens switch). */
  controls?: ReactNode;
  /** At the right end of the map's header bar (the Stores tab's Full page link). */
  action?: ReactNode;
}

/** Shared map for the Stores and Routes tabs: status pins, same-location stacks, legend, clustering, sync. */
export function MapView({ pins, selectedId, hoveredId, onSelect, onBoundsChange, className, unit = "locations", controls, action }: MapViewProps) {
  const config = useMapsConfig();
  // The map shows what the filters above select; the legend only explains the colours.
  const visible = pins;
  const groups = useMemo(() => groupPins(pins), [pins]);
  const fitSignature = useMemo(() => locationSignature(groups), [groups]);
  const counts = bucketCounts(pins, unit);
  // Only groups that have stores get a legend entry.
  const present = BUCKETS.filter((bucket) => counts[bucket] > 0);
  const showBadges = pins.some((pin) => pin.route_plan_id || (pin.visit_state && pin.visit_state !== "none"));
  const stacked = groups.filter((group) => group.pins.length > 1);
  const key = config.data?.google_maps_browser_key ?? "";
  const mapId = config.data?.google_map_id || undefined; // a vector map when the user has created a Map ID

  return (
    <div className={cn("flex min-h-[280px] flex-col overflow-hidden rounded-xl border bg-white", className)}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b px-3 py-2 text-xs text-slate-600">
      {controls}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1" role="group" aria-label="Map legend">
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1" aria-label="Status colours">
          {present.map((bucket) => (
            <li key={bucket} className="flex flex-col gap-1" title={`${BUCKET_META[bucket].members}. Bubbles go from light (few) to dark (many).`}>
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-full" style={{ background: BUCKET_META[bucket].color }} aria-hidden />
                {bucket} <span className="tabular-nums text-slate-400">{counts[bucket]}</span>
              </span>
              {/* This status's cluster bubbles, few → many, right under its name. */}
              <span
                className="h-1.5 w-full min-w-12 rounded-full"
                aria-label={`${bucket} clusters, light to dark`}
                style={{ background: `linear-gradient(to right, ${BUCKET_META[bucket].light}, ${BUCKET_META[bucket].dark})` }}
              />
            </li>
          ))}
          {present.length === 0 && <li className="text-slate-400">No stores</li>}
        </ul>
        {showBadges && (
          <div className="flex flex-wrap items-center gap-3" aria-label="Marker badges">
            <LegendDot color={OVERLAY_COLORS.route} label="In route" />
            <LegendDot color={OVERLAY_COLORS.visited} label="Visited" />
            <LegendDot color={OVERLAY_COLORS.partly} label="Partly visited" />
          </div>
        )}
        <span className="ml-auto font-mono text-[11px] text-slate-500" aria-live="polite">
          {unit === "screens" ? `${groups.reduce((sum, group) => sum + group.screens, 0)} screens · ` : ""}
          {visible.length} records · {groups.length} pins
          {stacked.length ? ` · ${stacked.reduce((sum, group) => sum + group.pins.length, 0)} at ${stacked.length} shared addresses` : ""}
        </span>
      </div>
      {action}
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
              // Fit the stores snugly: whole zoom levels leave a wide band of empty map around them.
              isFractionalZoomEnabled
              gestureHandling="greedy"
              mapTypeControl={false}
              streetViewControl={false}
              // Plain + / − zoom buttons (bottom right) instead of the combined camera control.
              zoomControl
              cameraControl={false}
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
  const clusterers = useRef(new globalThis.Map<StatusBucket, MarkerClusterer>()); // one per status group
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
    for (const bucket of BUCKETS) {
      clusterers.current.set(
        bucket,
        new MarkerClusterer({
          map,
          algorithm: new SuperClusterAlgorithm({ maxZoom: CLUSTER_MAX_ZOOM, radius: 60 }),
          renderer: clusterRenderer(bucket),
        }),
      );
    }
    const current = clusterers.current;
    return () => {
      for (const clusterer of current.values()) {
        clusterer.clearMarkers();
        clusterer.setMap(null);
      }
      current.clear();
    };
  }, [map]);

  // Rebuild markers only when the visible locations (or a location's status group) change; styling is the next
  // effect's job.
  const signature = clusterSignature(groups);
  useEffect(() => {
    if (!map || clusterers.current.size === 0) return;
    for (const clusterer of clusterers.current.values()) clusterer.clearMarkers();
    markers.current.clear();
    applied.current.clear();
    const byBucket = new globalThis.Map<StatusBucket, google.maps.Marker[]>();
    groups.forEach((group) => {
      const marker = new google.maps.Marker({ position: { lat: group.lat, lng: group.lng } });
      marker.addListener("click", () => {
        const current = latest.current.get(group.key);
        if (!current) return;
        if (current.pins.length === 1 && current.pins[0]) onSelectRef.current?.(current.pins[0].uid);
        else setOpenKey(current.key);
      });
      markers.current.set(group.key, marker);
      const bucket = bucketOf(group.status);
      byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), marker]);
    });
    for (const [bucket, created] of byBucket) clusterers.current.get(bucket)?.addMarkers(created);
  }, [map, signature]); // `signature` stands in for `groups`: rebuild only when locations or their groups change

  // Fit to the project's locations (v1: one pin → zoom 13) only when those change, not on legend toggles.
  const fitGroups = useRef(groups);
  fitGroups.current = groups;
  const moved = useRef(false); // the person panned or zoomed: stop refitting on resize
  const fit = useCallback(() => {
    if (!map) return;
    const bounds = boundsOf(fitGroups.current);
    if (!bounds) {
      map.setCenter(US_CENTER);
      map.setZoom(4);
    } else if (fitGroups.current.length === 1) {
      map.setCenter({ lat: bounds.north, lng: bounds.east });
      map.setZoom(13);
    } else {
      map.fitBounds(bounds, 24);
    }
  }, [map]);
  useEffect(() => {
    moved.current = false;
    fit();
  }, [fit, fitSignature]);
  // The map can be fitted while its box is still small (the page is laying out) and then grow, which leaves it
  // zoomed far out. Refit whenever the box changes size, until the person moves the map themselves.
  useEffect(() => {
    if (!map || typeof ResizeObserver === "undefined") return;
    const box = map.getDiv();
    const touched = () => (moved.current = true);
    const drag = map.addListener("dragstart", touched);
    box.addEventListener("wheel", touched, { passive: true });
    box.addEventListener("pointerdown", touched); // any use of the map, its zoom buttons included
    let last = `${box.clientWidth}x${box.clientHeight}`;
    const observer = new ResizeObserver(() => {
      const size = `${box.clientWidth}x${box.clientHeight}`;
      if (size === last) return;
      last = size;
      if (!moved.current) fit();
    });
    observer.observe(box);
    return () => {
      observer.disconnect();
      drag.remove();
      box.removeEventListener("wheel", touched);
      box.removeEventListener("pointerdown", touched);
    };
  }, [map, fit]);

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
    if (changed.length) for (const clusterer of clusterers.current.values()) clusterer.render(); // totals follow the weights
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
