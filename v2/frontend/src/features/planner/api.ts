import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { keys } from "@/lib/api/keys";
import { routePlansApi, storeSearchApi, type PoolFilters } from "@/lib/api/resources";
import type {
  DayInsert,
  DayLockSet,
  NextDay,
  Page,
  PlanStatus,
  PlanStoresAdd,
  RoutePlan,
  RoutePlanBundle,
  RoutePlanCreate,
  RoutePlanUpdate,
} from "@/lib/api/types";

/** Every plan with this status (a handful at a time in practice), paging through the API. */
export function useRoutePlans(status: PlanStatus) {
  return useQuery({
    queryKey: keys.routePlanList(status),
    queryFn: async () => {
      const all: RoutePlan[] = [];
      let cursor: string | null = null;
      do {
        const page: Page<RoutePlan> = await routePlansApi.list(status, { limit: 200, cursor });
        all.push(...page.items);
        cursor = page.next_cursor;
      } while (cursor);
      return all;
    },
  });
}

export function useRoutePlan(planId: string) {
  return useQuery({ queryKey: keys.routePlan(planId), queryFn: () => routePlansApi.get(planId) });
}

export function usePoolPins(filters: PoolFilters, enabled = true) {
  return useQuery({
    queryKey: keys.storeSearchPins(filters),
    queryFn: () => storeSearchApi.pins(filters),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function usePoolFacets(filters: PoolFilters) {
  return useQuery({
    queryKey: keys.storeSearchFacets(filters),
    queryFn: () => storeSearchApi.facets(filters),
    placeholderData: keepPreviousData,
  });
}

export function usePreviewPlan() {
  return useMutation({ mutationFn: (body: RoutePlanCreate) => routePlansApi.preview(body) });
}

/** Store claims change the Projects view ("in route") and the picker, so both are refreshed after a plan write. */
function useAfterPlanWrite() {
  const client = useQueryClient();
  return (bundle?: RoutePlanBundle) => {
    if (bundle) client.setQueryData(keys.routePlan(bundle.plan.id), bundle);
    return Promise.all([
      client.invalidateQueries({ queryKey: keys.routePlans, exact: false, refetchType: "active" }),
      client.invalidateQueries({ queryKey: keys.storeSearch, exact: false, refetchType: "active" }),
      client.invalidateQueries({ queryKey: keys.projects, exact: false, refetchType: "active" }),
    ]);
  };
}

export function useCreatePlan() {
  const after = useAfterPlanWrite();
  return useMutation({
    mutationFn: (body: RoutePlanCreate) => routePlansApi.create(body),
    onSuccess: (result) => after(result.bundle),
  });
}

export function usePlanMutations(planId: string) {
  const after = useAfterPlanWrite();
  const done = { onSuccess: (bundle: RoutePlanBundle) => after(bundle) };
  return {
    update: useMutation({ mutationFn: (body: RoutePlanUpdate) => routePlansApi.update(planId, body), ...done }),
    addStores: useMutation({
      mutationFn: (body: PlanStoresAdd) => routePlansApi.addStores(planId, body),
      onSuccess: (result) => after(result.bundle),
    }),
    removeStop: useMutation({
      mutationFn: ({ projectId, uid }: { projectId: string; uid: string }) => routePlansApi.removeStop(planId, projectId, uid),
      ...done,
    }),
    reassign: useMutation({
      mutationFn: ({ projectId, uid, installer, version }: { projectId: string; uid: string; installer: string; version?: number }) =>
        routePlansApi.reassign(planId, projectId, uid, installer, version),
      ...done,
    }),
    nextDay: useMutation({ mutationFn: (body: NextDay) => routePlansApi.nextDay(planId, body), ...done }),
    setDayLock: useMutation({ mutationFn: (body: DayLockSet) => routePlansApi.setDayLock(planId, body), ...done }),
    insert: useMutation({ mutationFn: (body: DayInsert) => routePlansApi.insert(planId, body), ...done }),
    moveToNextDay: useMutation({
      mutationFn: ({ projectId, uid, version }: { projectId: string; uid: string; version?: number }) =>
        routePlansApi.moveToNextDay(planId, projectId, uid, version),
      ...done,
    }),
    close: useMutation({ mutationFn: () => routePlansApi.close(planId), ...done }),
  };
}
