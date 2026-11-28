import { ThemedMap } from "@/components/map/ThemedMap";
import { APIProvider, Marker } from "@vis.gl/react-google-maps";
import { useMapsConfig } from "@/features/places/api";
import { cn } from "@/lib/utils";

/** About a one-mile radius around the point in a box this size. */
const NEIGHBOURHOOD_ZOOM = 14;

/** One point alone on a small map, zoomed to its neighbourhood: where an address that was just looked up is. */
export function PointMap({ at, title, className }: { at: { lat: number; lng: number }; title?: string; className?: string }) {
  const config = useMapsConfig();
  const key = config.data?.google_maps_browser_key ?? "";
  if (config.isPending) return <div className={cn("h-48 animate-pulse rounded-lg bg-slate-50", className)} />;
  if (!key) return <p className={cn("flex h-16 items-center justify-center rounded-lg bg-slate-50 text-sm text-slate-400", className)}>Map unavailable (no Google Maps key).</p>;
  return (
    <div className={cn("relative h-48 overflow-hidden rounded-lg border", className)} role="img" aria-label={title ? `Map of ${title}` : "Map of the location"}>
      <APIProvider apiKey={key}>
        {/* Keyed by position, so another address recentres the map. */}
        <ThemedMap
          key={`${at.lat},${at.lng}`}
          defaultCenter={at}
          defaultZoom={NEIGHBOURHOOD_ZOOM}
          gestureHandling="cooperative"
          mapTypeControl={false}
          streetViewControl={false}
          zoomControl
          cameraControl={false}
          fullscreenControl={false}
          className="absolute inset-0"
        >
          <Marker position={at} title={title} />
        </ThemedMap>
      </APIProvider>
    </div>
  );
}
