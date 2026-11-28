import { useEffect, useMemo, useRef, useState } from "react";
import { LocateFixed, Store } from "lucide-react";
import { Segmented } from "@/components/Segmented";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StartLocationField } from "@/features/planner/StartLocationField";
import { addressLines } from "@/components/map/PinPopup";
import type { Pin, StartLocation } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { useStoresUi, type PickedStore } from "@/stores/ui";

export const RADIUS_CHOICES = [5, 10, 25, 50] as const;
/** The server's limit, generous enough for a whole region. */
const MAX_RADIUS = 3000;

/** Parses the radius box: a positive number of miles up to the limit, else null. */
export function parseRadius(text: string): number | null {
  const miles = Number(text.trim());
  return text.trim() && Number.isFinite(miles) && miles > 0 && miles <= MAX_RADIUS ? miles : null;
}

/** A store clicked on the map as the Nearby centre: its point, labelled with its name and address. */
export const storePlace = (store: PickedStore): StartLocation => ({
  address: [store.name, store.address].filter(Boolean).join(" · "),
  lat: store.lat,
  lng: store.lng,
});

/** "Nearby" in the map's header: an address (Google's suggestions, checked by the server) and a radius in miles;
 *  Apply keeps only this project's stores within that distance, with every other filter still applying. The last
 *  store clicked on the map fills the address (while the form is open, or the next time it opens); it is never
 *  applied without Apply. */
export function NearbyControl() {
  const near = useStoresUi((state) => state.near);
  const setNear = useStoresUi((state) => state.setNear);
  const open = useStoresUi((state) => state.nearbyOpen);
  const setOpen = useStoresUi((state) => state.setNearbyOpen);
  const lastStore = useStoresUi((state) => state.lastStore);
  const [place, setPlace] = useState<StartLocation | null>(null);
  const [radius, setRadius] = useState("10");
  const miles = parseRadius(radius);
  // The click already used to fill the form: a later open does not undo an address typed since.
  const used = useRef(0);
  const fresh = lastStore && lastStore.seq !== used.current ? lastStore : null;

  // Opened (from its button or a pop-up's Nearby), or a pin clicked while open: start from the newest centre.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      // Start from what is applied now, so a radius can be changed without finding the address again.
      setPlace(near ? { address: near.address, lat: near.lat, lng: near.lng } : null);
      setRadius(String(near?.radius ?? 10));
    }
    if (open && fresh) {
      used.current = fresh.seq;
      setPlace(storePlace(fresh));
    }
    wasOpen.current = open;
  }, [open, fresh, near]);

  const apply = () => {
    if (!place || miles === null) return;
    setNear({ lat: place.lat, lng: place.lng, radius: miles, address: place.address });
    setOpen(false);
  };
  const fromStore = Boolean(lastStore && place && storePlace(lastStore).address === place.address);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          aria-label={near ? `Nearby: within ${near.radius} mi` : "Nearby"}
          className={cn(near && "border-brand/40 bg-brand/10 text-brand hover:bg-brand/15 hover:text-brand")}
        >
          <LocateFixed /> {near ? `Within ${near.radius} mi` : "Nearby"}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="glass w-[22rem] rounded-2xl p-0"
        // Clicking pins on the map keeps the form open (each click fills in that store); elsewhere closes it.
        onInteractOutside={(event) => event.target instanceof Element && event.target.closest(".gm-style") && event.preventDefault()}
      >
        <form
          aria-label="Nearby stores"
          className="divide-y divide-slate-900/[0.07]"
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
        >
          <div className="space-y-2 px-4 pt-3.5 pb-3">
            <p className="font-display text-lg leading-none tracking-[1.5px] text-slate-900">Stores Nearby</p>
            <StartLocationField label="Nearby address" value={place} onChange={setPlace} />
            <p className="flex items-center gap-1.5 text-xs text-slate-600">
              <Store className="size-3.5 shrink-0" aria-hidden />
              {fromStore ? "From the store you clicked on the map." : "Type an address, or click a store on the map."}
            </p>
          </div>
          <div className="space-y-2 px-4 py-3">
            <p className="font-mono text-[10px] tracking-wider text-slate-600 uppercase" id="nearby-radius">
              Within (Miles)
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                labelledBy="nearby-radius"
                options={RADIUS_CHOICES.map((choice) => ({ value: choice, text: `${choice} mi` }))}
                value={miles !== null && (RADIUS_CHOICES as readonly number[]).includes(miles) ? (miles as (typeof RADIUS_CHOICES)[number]) : null}
                onChange={(choice) => setRadius(String(choice))}
              />
              <Input
                type="number"
                min={0}
                step="any"
                inputMode="decimal"
                aria-label="Radius in miles"
                aria-invalid={miles === null}
                value={radius}
                onChange={(event) => setRadius(event.target.value)}
                className="h-9 w-20 bg-white px-2 text-sm tabular-nums"
              />
            </div>
            {miles === null && <p className="text-xs font-medium text-rose-700">Type a number of miles above 0 (up to {MAX_RADIUS}).</p>}
          </div>
          <div className="flex justify-end gap-2 px-4 py-2.5">
            {near && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-9"
                onClick={() => {
                  setNear(null);
                  setOpen(false);
                }}
              >
                Clear
              </Button>
            )}
            <Button type="submit" size="sm" className="h-9 px-4" disabled={!place || miles === null}>
              Apply
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** The map's pin actions for Nearby: a click on a store remembers it (the form starts from it), and the pop-up's
 *  Nearby action also opens the form. Both stable (store actions). */
export function useNearbyPinActions(): { onPinClick: (pin: Pin) => void; onNearby: (pin: Pin) => void } {
  const pickStore = useStoresUi((state) => state.pickStore);
  const setOpen = useStoresUi((state) => state.setNearbyOpen);
  return useMemo(() => {
    const onPinClick = (pin: Pin) =>
      pickStore({ uid: pin.uid, name: pin.store_name, address: addressLines(pin).join(", "), lat: pin.lat, lng: pin.lng });
    return {
      onPinClick,
      onNearby: (pin: Pin) => {
        onPinClick(pin);
        setOpen(true);
      },
    };
  }, [pickStore, setOpen]);
}
