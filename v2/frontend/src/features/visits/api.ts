import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { keys } from "@/lib/api/keys";
import { storeCommentsApi, storesApi, visitsApi } from "@/lib/api/resources";
import { ApiError, type StoreCommentInput, type VisitInput } from "@/lib/api/types";

/** The store's servicing history, newest first (one page of 100; a store rarely has more). */
export function useVisits(projectId: string | null, uid: string | null) {
  return useQuery({
    queryKey: keys.visits(projectId ?? "", uid ?? ""),
    queryFn: () => visitsApi.list(projectId ?? "", uid ?? "", { limit: 100 }),
    enabled: Boolean(projectId && uid),
  });
}

/** A visit changes the history, the store's per-stick visit times (overlays), and the plan stop it belongs to. */
export function useCreateVisit(projectId: string, uid: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: VisitInput) => visitsApi.create(projectId, uid, body),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: keys.visits(projectId, uid) }),
        client.invalidateQueries({ queryKey: keys.store(projectId, uid) }),
        client.invalidateQueries({ queryKey: [...keys.stores(projectId), "pins"] }),
        client.invalidateQueries({ queryKey: [...keys.stores(projectId), "list"] }),
        client.invalidateQueries({ queryKey: keys.routePlans, exact: false }),
        client.invalidateQueries({ queryKey: ["lists"], exact: false }),
      ]),
  });
}

/** The store's comments as log entries of their own, newest first (one page of 100). */
export function useStoreComments(projectId: string | null, uid: string | null) {
  return useQuery({
    queryKey: keys.storeComments(projectId ?? "", uid ?? ""),
    queryFn: () => storeCommentsApi.list(projectId ?? "", uid ?? "", { limit: 100 }),
    enabled: Boolean(projectId && uid),
  });
}

/** A store comment is a log entry and the store's latest comment: no screen, plan stop or KPI changes. */
export function useCreateStoreComment(projectId: string, uid: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: StoreCommentInput) => storeCommentsApi.create(projectId, uid, body),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: keys.storeComments(projectId, uid) }),
        client.invalidateQueries({ queryKey: keys.store(projectId, uid) }),
        client.invalidateQueries({ queryKey: [...keys.stores(projectId), "list"] }),
      ]),
  });
}

/** A DD code as the server matches it (`dd-abc123` → `DD_ABC123`), and the uid of its venue in the all-venues list. */
export const venueCodeKey = (code: string) => code.replace(/\s+/g, "").toUpperCase().replace(/-/g, "_");
export const venueUid = (code: string) => `v-${venueCodeKey(code).replace(/[^A-Z0-9_]/g, "")}`;

/** What the Dolphin data (CMS) has for a DD code: its store name, venue name, address, PA, DMA and status. `null`
 *  when the code is not in the data (or is archived there). Read from the planner's all-venues list. */
export function useVenue(code: string) {
  const key = venueCodeKey(code);
  return useQuery({
    queryKey: ["venue", key],
    queryFn: async () => {
      try {
        return await storesApi.get("venues", venueUid(code));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: key.length >= 5,
    staleTime: 5 * 60_000,
    retry: false,
  });
}
