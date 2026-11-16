import { APIProvider, Map, Marker } from "@vis.gl/react-google-maps";
import { MapPin, MapPinOff } from "lucide-react";
import { useMapsConfig } from "@/features/places/api";
import type { Stop } from "@/lib/api/types";
import { cn } from "@/lib/utils";

/** About a one-mile radius around the store in a box this size. */
const NEIGHBOURHOOD_ZOOM = 14;

/** Where the map draws a store: the Dolphin data's location when it has one, else the sheet's (as the big map). */
export function shownLocation(stop: Pick<Stop, "lat" | "lng" | "device">): { lat: number; lng: number } | null {
  const lat = stop.device?.lat ?? stop.lat;
  const lng = stop.device?.lng ?? stop.lng;
  return lat === null || lat === undefined || lng === null || lng === undefined ? null : { lat, lng };
}

/** This store alone on a small map, zoomed to its neighbourhood (about a mile around), with a link to Google Maps. */
export function StoreLocationMap({ stop, className }: { stop: Stop; className?: string }) {
  const config = useMapsConfig();
  const key = config.data?.google_maps_browser_key ?? "";
  const at = shownLocation(stop);
  return (
    <section aria-label="Location" className={cn("rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5", className)}>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-slate-600">
          <MapPin size={13} /> Location
        </h3>
        {at && (
          <a
            href={`https://www.google.com/maps/search/?api=1&query=${at.lat},${at.lng}`}
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-xs text-brand hover:underline"
          >
            Open in Google Maps
          </a>
        )}
      </div>
      {!at ? (
        <p className="flex h-24 items-center justify-center gap-1.5 rounded-md bg-slate-50 text-sm text-slate-400">
          <MapPinOff size={15} /> No map location yet: verify the address.
        </p>
      ) : config.isPending ? (
        <div className="h-64 animate-pulse rounded-md bg-slate-50" />
      ) : !key ? (
        <p className="flex h-24 items-center justify-center rounded-md bg-slate-50 text-sm text-slate-400">Map unavailable (no Google Maps key).</p>
      ) : (
        <div className="relative h-64 overflow-hidden rounded-lg">
          <APIProvider apiKey={key}>
            {/* Keyed by position, so a verified or overwritten location recentres the map. */}
            <Map
              key={`${at.lat},${at.lng}`}
              defaultCenter={at}
              defaultZoom={NEIGHBOURHOOD_ZOOM}
              gestureHandling="cooperative"
              mapTypeControl={false}
              streetViewControl={false}
              // Plain + / − zoom buttons (bottom right) instead of the combined camera control.
              zoomControl
              cameraControl={false}
              fullscreenControl={false}
              className="absolute inset-0"
            >
              <Marker position={at} title={stop.store_name} />
            </Map>
          </APIProvider>
        </div>
      )}
    </section>
  );
}
