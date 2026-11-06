import { useEffect, useMemo, useRef, useState } from "react";
import { APIProvider, InfoWindow, Map, useMap } from "@vis.gl/react-google-maps";
import { MarkerClusterer, SuperClusterAlgorithm } from "@googlemaps/markerclusterer";
import { MapPinOff } from "lucide-react";
import {
  boundsOf,
  changedStyles,
  filterByStatus,
  groupPins,
  locationSignature,
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

export interface MapViewProps {
  pins: Pin[];
  selectedId?: string | null;
  hoveredId?: string | null;
  onSelect?: (uid: string) => void;
  /** Fires once a pan/zoom settles (`idle`), not on every frame; the Stores tab uses it for "only stores in view". */
  onBoundsChange?: (bounds: Bounds) => void;
  className?: string;
}

/** Shared map for the Stores and Routes tabs: status pins, same-location stacks, legend, clustering, sync. */
export function MapView({ pins, selectedId, hoveredId, onSelect, onBoundsChange, className }: MapViewProps) {
  const config = useMapsConfig();
  const [active, setActive] = useState<Set<StopStatus>>(new Set());
  const visible = useMemo(() => filterByStatus(pins, active), [pins, active]);
  const groups = useMemo(() => groupPins(visible), [visible]);
  const fitSignature = useMemo(() => locationSignature(groupPins(pins)), [pins]);
  const counts = statusCounts(pins);
  const stacked = groups.filter((group) => group.pins.length > 1);
  const key = config.data?.google_maps_browser_key ?? "";
  const mapId = config.data?.google_map_id || undefined; // a vector map when the user has created a Map ID

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
        {pins.some((pin) => pin.route_plan_id || (pin.visit_state && pin.visit_state !== "none")) && (
          <span className="flex items-center gap-2 font-mono text-[10px] text-slate-500" aria-label="Marker badges">
            <span className="flex items-center gap-1">
              <span className="size-2.5 rounded-full" style={{ background: OVERLAY_COLORS.route }} /> In route
            </span>
            <span className="flex items-center gap-1">
              <span className="size-2.5 rounded-full" style={{ background: OVERLAY_COLORS.visited }} /> Visited
            </span>
            <span className="flex items-center gap-1">
              <span className="size-2.5 rounded-full" style={{ background: OVERLAY_COLORS.partly }} /> Partly visited
            </span>
          </span>
        )}
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
              <Markers groups={groups} fitSignature={fitSignature} selectedId={selectedId} hoveredId={hoveredId} onSelect={onSelect} />
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
  /** Location signature over every pin (before the legend filter): the map refits only when it changes. */
  fitSignature: string;
  selectedId?: string | null;
  hoveredId?: string | null;
  onSelect?: (uid: string) => void;
}

/** Imperative markers (one per location) in a clusterer that only clusters at low zoom. */
function Markers({ groups, fitSignature, selectedId, hoveredId, onSelect }: MarkersProps) {
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
    const next = markerStyles(groups, selectedId, hoveredId);
    for (const key of changedStyles(applied.current, next)) {
      const marker = markers.current.get(key);
      const style = next.get(key);
      if (!marker || !style) continue;
      const group = latest.current.get(key);
      marker.setIcon(icon(style));
      marker.setZIndex(markerZIndex(style));
      marker.setTitle(style.count > 1 ? `${style.count} locations` : group?.pins[0]?.store_name ?? "");
      applied.current.set(key, style);
    }
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

function icon({ status, count, emphasis, overlay }: MarkerStyle): google.maps.Icon {
  const scale = emphasis === "normal" ? 1 : 1.2;
  return {
    url: markerSvg(status, count, emphasis, overlay),
    scaledSize: new google.maps.Size(40 * scale, 50 * scale),
    anchor: new google.maps.Point(20 * scale, 47 * scale),
  };
}
