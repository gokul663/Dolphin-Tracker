import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { keys } from "@/lib/api/keys";
import { visitSearchApi } from "@/lib/api/resources";

/** Fewer characters than this are not sent (the server would find nothing). */
export const MIN_QUERY = 2;
/** How many stores a search shows; more than this asks for a narrower search. */
export const SEARCH_LIMIT = 25;

/** Stores of every project for a DD code or address. The last results stay on screen while the next load. */
export function useVisitSearch(q: string) {
  const query = q.trim();
  return useQuery({
    queryKey: keys.visitSearch(query),
    queryFn: () => visitSearchApi.search(query, SEARCH_LIMIT),
    enabled: query.length >= MIN_QUERY,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}
