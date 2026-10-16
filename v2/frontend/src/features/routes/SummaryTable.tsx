import { Check, Map as MapIcon } from "lucide-react";
import { filterDays, installerColor, mapsUrlForStops, MAP_MAX_STOPS, routableStops, tally, uniqueCities, type RouteFilters } from "@/features/routes/routeModel";
import type { RoutesBundle } from "@/lib/api/types";

/** v1 summary view: one row per installer-day with counts, cities and the first route link. */
export function SummaryTable({ bundle, installers, filters }: { bundle: RoutesBundle; installers: string[]; filters: RouteFilters }) {
  const rows = installers.flatMap((installer) =>
    filterDays(bundle.routes[installer] ?? [], filters).map(({ day, stops }) => ({ installer, day, stops })),
  );
  if (!rows.length) return <p className="rounded-xl border bg-white p-8 text-center text-sm text-slate-500">No days match these filters.</p>;
  return (
    <div className="overflow-x-auto rounded-xl border bg-white">
      <table className="w-full min-w-[820px] text-sm">
        <thead className="bg-slate-50 font-mono text-[10px] uppercase tracking-wider text-slate-500">
          <tr className="text-left">
            {["Installer", "Day", "Stops", "Completed", "Upcoming", "Tech", "Other", "Cities covered", "Open route"].map((label) => (
              <th key={label} className="p-2">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ installer, day, stops }) => {
            const counts = tally(stops);
            const active = routableStops(stops);
            return (
              <tr key={`${installer}-${day}`} className="border-t">
                <td className="p-2 font-semibold" style={{ color: installerColor(bundle.installers, installer) }}>
                  {installer}
                </td>
                <td className="p-2">Day {day}</td>
                <td className="p-2">{stops.length}</td>
                <td className="p-2 font-bold text-emerald-700">{counts.complete}</td>
                <td className="p-2 font-bold text-amber-700">{counts.pending}</td>
                <td className="p-2 font-bold text-rose-700">{counts.technical}</td>
                <td className="p-2 font-bold text-violet-700">{counts.other}</td>
                <td className="p-2 text-slate-500">{uniqueCities(stops).slice(0, 5).join(", ")}</td>
                <td className="p-2">
                  {active.length ? (
                    <a className="inline-flex items-center gap-1 text-brand hover:underline" href={mapsUrlForStops(active.slice(0, MAP_MAX_STOPS))} target="_blank" rel="noopener noreferrer">
                      <MapIcon size={14} /> Open ({active.length})
                    </a>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-emerald-700">
                      <Check size={14} /> Route complete
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
