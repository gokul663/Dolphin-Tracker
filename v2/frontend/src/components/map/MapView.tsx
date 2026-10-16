import { useEffect, useMemo, useRef, useState } from "react";
import { APIProvider, InfoWindow, Map, useMap } from "@vis.gl/react-google-maps";
import { MarkerClusterer, SuperClusterAlgorithm } from "@googlemaps/markerclusterer";
import { MapPinOff } from "lucide-react";
import {
  boundsOf,
  filterByStatus,
  groupPins,
  markerSvg,
  statusCounts,
  toggleStatus,
  type Bounds,
  type PinGroup,
} from "@/components/map/pins";
import { useMapsConfig } from "@/features/places/api";
import { STOP_STATUSES, type Pin, type StopStatus } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";
import { cn } from "@/lib/utils";

/** Clusters form at this zoom and below; closer in, every location gets its own pin. */
export const CLUSTER_MAX_ZOOM = 11;
const US_CENTER = { lat: 39.5, lng: -98.35 };

export interface MapViewProps {
  pins: Pin[];
  selectedId?: string | null;
  hoveredId?: string | null;
  onSelect?: (uid: string) => void;
  /** Fires on every pan/zoom with the visible bounds; the Stores tab uses it for "only stores in view". */
  onBoundsChange?: (bounds: Bounds) => void;
  className?: string;
}

/** Shared map for the Stores and Routes tabs: status pins, same-location stacks, legend, clustering, sync. */
export function MapView({ pins, selectedId, hoveredId, onSelect, onBoundsChange, className }: MapViewProps) {
  const config = useMapsConfig();
  const [active, setActive] = useState<Set<StopStatus>>(new Set());
  const visible = useMemo(() => filterByStatus(pins, active), [pins, active]);
  const groups = useMemo(() => groupPins(visible), [visible]);
  const counts = statusCounts(pins);
  const stacked = groups.filter((group) => group.pins.length > 1);
  const key = config.data?.google_maps_browser_key ?? "";

  return (
    <div className={cn("flex min-h-[360px] flex-col overflow-hidden rounded-xl border bg-white", className)}>
      <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2" role="group" aria-label="Map legend">
        {STOP_STATUSES.map((status) => {
          const on = active.size === 0 || active.has(status);
          return (
            <button
              key={status}
              type="button"
              aria-pressed={on}
              onClick={() => setActive((current) => toggleStatus(current, STOP_STATUSES, status))}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider",
                on ? "border-slate-300 bg-white text-slate-700" : "border-transparent bg-slate-100 text-slate-400 line-through",
              )}
              title={`Toggle ${STATUS_META[status].label} pins`}
            >
              <span className="size-2.5 rounded-full" style={{ background: STATUS_META[status].color }} />
              {STATUS_META[status].label} {counts[status]}
            </button>
          );
        })}
        <span className="ml-auto font-mono text-[10px] text-slate-500" aria-live="polite">
          {visible.length} records · {groups.length} pins
          {stacked.length ? ` · ${stacked.reduce((sum, group) => sum + group.pins.length, 0)} at ${stacked.length} shared addresses` : ""}
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        {config.isPending ? (
          <MapMessage text="Loading map…" />
        ) : !key ? (
          <MapMessage text="Map unavailable: no Google Maps browser key is configured (DT_GOOGLE_BROWSER_KEY)." />
        ) : (
          <APIProvider apiKey={key}>
            <Map
              defaultCenter={US_CENTER}
              defaultZoom={4}
              gestureHandling="greedy"
              mapTypeControl={false}
              streetViewControl={false}
              className="absolute inset-0"
              onBoundsChanged={(event) => onBoundsChange?.(event.detail.bounds)}
            >
              <Markers groups={groups} selectedId={selectedId} hoveredId={hoveredId} onSelect={onSelect} />
            </Map>
          </APIProvider>
        )}
      </div>
    </div>
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
  selectedId?: string | null;
  hoveredId?: string | null;
  onSelect?: (uid: string) => void;
}

/** Imperative markers (one per location) in a clusterer that only clusters at low zoom. */
function Markers({ groups, selectedId, hoveredId, onSelect }: MarkersProps) {
  const map = useMap();
  const clusterer = useRef<MarkerClusterer | null>(null);
  const markers = useRef(new globalThis.Map<string, google.maps.Marker>());
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);
  const [openGroup, setOpenGroup] = useState<PinGroup | null>(null);

  useEffect(() => {
    if (!map) return;
    clusterer.current = new MarkerClusterer({
      map,
      algorithm: new SuperClusterAlgorithm({ maxZoom: CLUSTER_MAX_ZOOM, radius: 60 }),
    });
    return () => {
      clusterer.current?.clearMarkers();
      clusterer.current?.setMap(null);
      clusterer.current = null;
    };
  }, [map]);

  // Rebuild markers when the set of locations changes, and fit the map to them (v1: one pin → zoom 13).
  const signature = groups.map((group) => `${group.key}:${group.status}:${group.pins.length}`).join(",");
  useEffect(() => {
    if (!map || !clusterer.current) return;
    clusterer.current.clearMarkers();
    markers.current.clear();
    const created = groups.map((group) => {
      const marker = new google.maps.Marker({
        position: { lat: group.lat, lng: group.lng },
        title: group.pins.length > 1 ? `${group.pins.length} locations` : group.pins[0]?.store_name,
        icon: icon(group.status, group.pins.length, "normal"),
        zIndex: group.pins.length > 1 ? 1000 + group.pins.length : 1,
      });
      marker.addListener("click", () => {
        if (group.pins.length === 1 && group.pins[0]) onSelectRef.current?.(group.pins[0].uid);
        else setOpenGroup(group);
      });
      for (const pin of group.pins) markers.current.set(pin.uid, marker);
      return marker;
    });
    clusterer.current.addMarkers(created);
    const bounds = boundsOf(groups);
    if (!bounds) {
      map.setCenter(US_CENTER);
      map.setZoom(4);
    } else if (groups.length === 1) {
      map.setCenter({ lat: bounds.north, lng: bounds.east });
      map.setZoom(13);
    } else {
      map.fitBounds(bounds, 54);
    }
  }, [map, signature]); // `signature` stands in for `groups`: rebuild only when locations change

  // Selection and hover only restyle the affected markers; they never refit the map.
  useEffect(() => {
    const byMarker = new globalThis.Map<google.maps.Marker, PinGroup>();
    for (const group of groups) {
      const marker = group.pins[0] && markers.current.get(group.pins[0].uid);
      if (marker) byMarker.set(marker, group);
    }
    for (const [marker, group] of byMarker) {
      const uids = group.pins.map((pin) => pin.uid);
      const emphasis = selectedId && uids.includes(selectedId) ? "selected" : hoveredId && uids.includes(hoveredId) ? "hover" : "normal";
      marker.setIcon(icon(group.status, group.pins.length, emphasis));
      marker.setZIndex(emphasis === "normal" ? (group.pins.length > 1 ? 1000 + group.pins.length : 1) : 5000);
    }
    const selected = selectedId ? markers.current.get(selectedId) : undefined;
    const position = selected?.getPosition();
    if (map && position && !map.getBounds()?.contains(position)) map.panTo(position);
  }, [map, signature, selectedId, hoveredId]);

  if (!openGroup) return null;
  return (
    <InfoWindow position={{ lat: openGroup.lat, lng: openGroup.lng }} onCloseClick={() => setOpenGroup(null)}>
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
                  setOpenGroup(null);
                }}
              >
                <b>
                  {index + 1}. {pin.store_name}
                </b>{" "}
                <span className="text-slate-500">
                  {pin.installer || "Not assigned"} · Day {pin.day} ·{" "}
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

function icon(status: StopStatus, count: number, emphasis: "normal" | "hover" | "selected"): google.maps.Icon {
  const scale = emphasis === "normal" ? 1 : 1.2;
  return {
    url: markerSvg(status, count, emphasis),
    scaledSize: new google.maps.Size(40 * scale, 50 * scale),
    anchor: new google.maps.Point(20 * scale, 47 * scale),
  };
}
