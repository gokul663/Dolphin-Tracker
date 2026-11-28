import { LocateFixed, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Pin } from "@/lib/api/types";
import { STATUS_META } from "@/lib/status";

/** A pin's address as two lines: the street, then "city, ST zip". Blank parts are left out (planner pins have none). */
export function addressLines(pin: Pick<Pin, "addr" | "city" | "state" | "zip">): string[] {
  const place = [pin.city, [pin.state, pin.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [pin.addr ?? "", place].filter(Boolean);
}

function Address({ pin }: { pin: Pin }) {
  const lines = addressLines(pin);
  if (!lines.length) return null;
  return (
    <address className="not-italic text-slate-700">
      {lines.map((line) => (
        <div key={line}>{line}</div>
      ))}
    </address>
  );
}

/** The status in dark text with a dot of its colour: a yellow or green word alone would not be readable. */
function Status({ pin }: { pin: Pin }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-semibold text-slate-800">
      <span data-testid="status-dot" className="size-2 shrink-0 rounded-full" style={{ background: STATUS_META[pin.status].color }} aria-hidden />
      {STATUS_META[pin.status].label}
    </span>
  );
}

/** A single click on a store's pin: name, ExtID, address and status. With `onOpen`, an "Open store" button (what a
 *  double click on the pin does); with `onNearby`, a Nearby action that starts the Nearby form from this store.
 *  Without either it is read only. `map-popup` gives Google's box around it the glass look (index.css). */
export function StorePopup({ pin, onOpen, onNearby }: { pin: Pin; onOpen?: (uid: string) => void; onNearby?: (pin: Pin) => void }) {
  return (
    <div className="map-popup w-64 max-w-full space-y-2 text-sm text-slate-800" aria-label={`Store ${pin.store_name}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="font-semibold text-slate-950">{pin.store_name}</div>
          {pin.display_id && <div className="font-mono text-xs text-slate-600">ExtID {pin.display_id}</div>}
        </div>
        {onOpen && (
          <Button variant="outline" size="icon" aria-label="Open store" title="Open store (or double-click the pin)" className="-mt-0.5 bg-white/80" onClick={() => onOpen(pin.uid)}>
            <Maximize2 />
          </Button>
        )}
      </div>
      <Address pin={pin} />
      <Status pin={pin} />
      {onNearby && (
        <div className="border-t border-slate-900/[0.08] pt-2">
          <Button variant="outline" size="sm" className="h-9 bg-white/80" onClick={() => onNearby(pin)}>
            <LocateFixed /> Nearby
          </Button>
        </div>
      )}
    </div>
  );
}

/** Several stores at one address: the address once, then each store. With `onSelect` an entry opens its store. */
export function LocationPopup({ pins, onSelect }: { pins: Pin[]; onSelect?: (uid: string) => void }) {
  const first = pins[0];
  return (
    <div className="map-popup max-w-64 space-y-1 text-sm" aria-label={`${pins.length} locations at this address`}>
      <div className="font-semibold">{pins.length} locations at this address</div>
      {first && <Address pin={first} />}
      <ul className="max-h-48 space-y-1 overflow-y-auto">
        {pins.map((pin, index) => {
          const body = (
            <>
              <b>
                {index + 1}. {pin.store_name}
              </b>{" "}
              <span className="text-slate-500">
                {pin.display_id ? <span className="font-mono text-xs">{pin.display_id} · </span> : ""}
                {pin.installer ? `${pin.installer} · Day ${pin.day} · ` : ""}
              </span>
              <Status pin={pin} />
            </>
          );
          return (
            <li key={pin.uid}>
              {onSelect ? (
                <button type="button" className="text-left hover:underline" onClick={() => onSelect(pin.uid)}>
                  {body}
                </button>
              ) : (
                body
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
