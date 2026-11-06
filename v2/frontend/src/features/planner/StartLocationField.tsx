import { useEffect, useId, useState } from "react";
import { Check, Loader2, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
}

/** An address checked with Google (or "lat, lng" typed directly) that becomes a start location. */
export function StartLocationField({ label, value, onChange, className }: Props) {
  const listId = useId();
  const [text, setText] = useState(value?.address ?? "");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [error, setError] = useState("");
  const validate = useValidateAddress();

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

  const resolve = async () => {
    setError("");
    const query = text.trim();
    const point = parseCoordinates(query);
    if (point) {
      onChange({ address: query, ...point });
      return;
    }
    if (!query) return;
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
    }
  };

  const confirmed = value !== null && text.trim() === value.address;
  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex gap-1.5">
        <div className="relative flex-1">
          <MapPin className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400" />
          <Input
            aria-label={label}
            className="pl-8"
            list={listId}
            value={text}
            placeholder="Address, or lat, lng"
            onChange={(event) => {
              setText(event.target.value);
              if (value && event.target.value.trim() !== value.address) onChange(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void resolve();
              }
            }}
          />
          <datalist id={listId}>
            {suggestions.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
        </div>
        <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => void resolve()} disabled={validate.isPending}>
          {validate.isPending ? <Loader2 className="animate-spin" /> : confirmed ? <Check className="text-emerald-600" /> : null}
          {confirmed ? "Set" : "Find"}
        </Button>
      </div>
      {confirmed && (
        <p className="font-mono text-[10px] text-slate-500">
          {value.lat.toFixed(5)}, {value.lng.toFixed(5)}
        </p>
      )}
      {error && <p className="text-xs text-rose-700">{error}</p>}
    </div>
  );
}
