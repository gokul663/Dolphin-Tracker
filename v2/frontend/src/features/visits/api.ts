import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { keys } from "@/lib/api/keys";
import { visitsApi } from "@/lib/api/resources";
import type { VisitInput } from "@/lib/api/types";

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
