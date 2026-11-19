import { useEffect, useRef, useState } from "react";
import { Check, Loader2, MapPin } from "lucide-react";
import { SuggestInput } from "@/components/SuggestInput";
import { PointMap } from "@/components/map/PointMap";
import { parseCoordinates } from "@/features/planner/planModel";
import { useValidateAddress } from "@/features/places/api";
import { placesApi } from "@/lib/api/resources";
import type { StartLocation } from "@/lib/api/types";
import { cn } from "@/lib/utils";

interface Props {
  label: string;
  value: StartLocation | null;
  onChange: (value: StartLocation | null) => void;
  className?: string;
  /** Show the location on a small map once it is found. */
  map?: boolean;
}

/** An address checked with Google (or "lat, lng" typed directly) that becomes a start location. It is looked up as
 *  soon as a suggestion is picked, on Enter, or when the box is left: there is no button to press. */
export function StartLocationField({ label, value, onChange, className, map = false }: Props) {
  const [text, setText] = useState(value?.address ?? "");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [error, setError] = useState("");
  const validate = useValidateAddress();
  const looking = useRef(""); // the text being looked up, so one address is not looked up twice

  useEffect(() => setText(value?.address ?? ""), [value?.address]);

  useEffect(() => {
    const query = text.trim();
    if (query.length < 4 || parseCoordinates(query) || query === value?.address) return;
    const timer = window.setTimeout(() => {
      placesApi.autocomplete(query).then(
        (result) => setSuggestions(result.suggestions),
        () => setSuggestions([]),
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [text, value?.address]);

  const resolve = async (typed: string) => {
    const query = typed.trim();
    if (!query || query === value?.address || query === looking.current) return;
    setError("");
    const point = parseCoordinates(query);
    if (point) {
      onChange({ address: query, ...point });
      return;
    }
    looking.current = query;
    try {
      const result = await validate.mutateAsync(query);
      if (result.ok && result.lat !== null && result.lng !== null) {
        onChange({ address: result.formatted || query, lat: result.lat, lng: result.lng });
        setText(result.formatted || query);
      } else {
        setError(result.error || "Address not found. Try a fuller address, or type coordinates like 33.75, -84.39.");
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Address lookup failed");
    } finally {
      looking.current = "";
    }
  };

  const confirmed = value !== null && text.trim() === value.address;
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="relative">
        <MapPin className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400" />
        <SuggestInput
          aria-label={label}
          className="px-8"
          options={suggestions}
          filter={false}
          value={text}
          placeholder="Address, or lat, lng"
          onValueChange={(next) => {
            setText(next);
            setError("");
            if (value && next.trim() !== value.address) onChange(null);
          }}
          onPick={(option) => void resolve(option)}
          onBlur={() => text.trim().length >= 4 && void resolve(text)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void resolve(text);
            }
          }}
        />
        <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2" aria-hidden>
          {validate.isPending ? <Loader2 className="size-4 animate-spin text-slate-400" /> : confirmed ? <Check className="size-4 text-emerald-600" /> : null}
        </span>
      </div>
      {validate.isPending && <p className="text-xs text-slate-500">Looking up the address…</p>}
      {confirmed && (
        <p className="font-mono text-[10px] text-slate-500" role="status">
          Found: {value.lat.toFixed(5)}, {value.lng.toFixed(5)}
        </p>
      )}
      {error && <p className="text-xs text-rose-700">{error}</p>}
      {map && confirmed && <PointMap at={value} title={value.address} />}
    </div>
  );
}
