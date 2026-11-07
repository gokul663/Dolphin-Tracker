import { useState } from "react";
import { ExternalLink, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useSearchPlaces } from "@/features/places/api";
import type { PlaceHit } from "@/lib/api/types";

interface Props {
  address: string;
  name: string;
  onPick: (hit: PlaceHit) => void;
  /** Accessible name of the button (e.g. "Search Google, row 12"). */
  label?: string;
}

/** "Search Google": the places Google Search lists for the store name and its address, to pick the right one when
 *  the address check could not place it. Each can be opened in Google Maps first. */
export function GoogleSearchPicker({ address, name, onPick, label = "Search Google" }: Props) {
  const [open, setOpen] = useState(false);
  const search = useSearchPlaces();
  const run = () => search.mutate({ address, name });
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) run();
      }}
    >
      <PopoverTrigger asChild>
        <Button size="xs" variant="outline" aria-label={label} disabled={!address.trim()}>
          <Search /> Search Google
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[26rem] p-0">
        <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-slate-500">
          <span className="truncate">
            Google results for <strong>{[name, address].filter(Boolean).join(", ")}</strong>
          </span>
          <Button size="xs" variant="ghost" onClick={run} disabled={search.isPending}>
            Search again
          </Button>
        </div>
        {search.isPending ? (
          <p className="flex items-center gap-2 p-4 text-sm text-slate-500">
            <Loader2 className="size-4 animate-spin" /> Searching Google…
          </p>
        ) : search.isError ? (
          <p className="p-4 text-sm text-rose-700">Could not search Google: {search.error.message}</p>
        ) : (search.data ?? []).length === 0 ? (
          <p className="p-4 text-sm text-slate-500">Google found no place for this store. Correct the address and try again.</p>
        ) : (
          <ul className="max-h-80 divide-y overflow-y-auto" aria-label="Google results">
            {search.data!.map((hit) => (
              <li key={hit.place_id || `${hit.lat},${hit.lng}`} className="flex items-start gap-2 px-3 py-2">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left hover:text-brand"
                  onClick={() => {
                    onPick(hit);
                    setOpen(false);
                  }}
                >
                  <span className="block truncate text-sm font-medium">{hit.name || hit.formatted}</span>
                  <span className="block truncate text-xs text-slate-500">{hit.formatted}</span>
                </button>
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${hit.lat},${hit.lng}${hit.place_id ? `&query_place_id=${hit.place_id}` : ""}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-0.5 shrink-0 text-slate-400 hover:text-brand"
                  aria-label={`See ${hit.name || hit.formatted} on Google Maps`}
                >
                  <ExternalLink className="size-4" />
                </a>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
