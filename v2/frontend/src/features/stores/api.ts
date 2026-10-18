import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { keys } from "@/lib/api/keys";
import { storesApi, type StoreFilters } from "@/lib/api/resources";
import type { AppendStops, Pin, ProgressUpdate, RoutesBundle, Stop, StoreDetailsUpdate } from "@/lib/api/types";
import { patchPin, patchStopInPages, patchStopInRoutes, type StopPages } from "@/features/stores/cache";

export const STORE_PAGE_SIZE = 100;

export function useStoreList(projectId: string, filters: StoreFilters) {
  return useInfiniteQuery({
    queryKey: keys.storeList(projectId, filters),
    queryFn: ({ pageParam }) => storesApi.list(projectId, filters, { limit: STORE_PAGE_SIZE, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    placeholderData: keepPreviousData,
  });
}

export function usePins(projectId: string, filters: StoreFilters) {
  return useQuery({
    queryKey: keys.pins(projectId, filters),
    queryFn: () => storesApi.pins(projectId, filters),
    placeholderData: keepPreviousData,
  });
}

export function useStore(projectId: string, uid: string | null) {
  return useQuery({
    queryKey: keys.store(projectId, uid ?? ""),
    queryFn: () => storesApi.get(projectId, uid ?? ""),
    enabled: Boolean(uid),
  });
}

/** Write the server's version of a stop into every cached list page and its detail entry. */
function useStoreStopInCaches(projectId: string) {
  const client = useQueryClient();
  return (stop: Stop) => {
    client.setQueriesData<StopPages>({ queryKey: [...keys.stores(projectId), "list"] }, (data) =>
      patchStopInPages(data, stop.uid, stop),
    );
    client.setQueryData(keys.store(projectId, stop.uid), stop);
  };
}

export function useUpdateStoreDetails(projectId: string) {
  const client = useQueryClient();
  const store = useStoreStopInCaches(projectId);
  return useMutation({
    mutationFn: ({ uid, body }: { uid: string; body: StoreDetailsUpdate }) =>
      storesApi.updateDetails(projectId, uid, body),
    onSuccess: (stop, { body }) => {
      store(stop); // the per-page patch covers every other change
      const touched = editedKeys(body);
      const moved = ["addr", "city", "state", "zip"].some((key) => touched.has(key));
      return Promise.all([
        // Pins only change when the address (and so the geocode) does.
        moved ? client.invalidateQueries({ queryKey: [...keys.stores(projectId), "pins"] }) : undefined,
        // A list refetches only if the edit can move the row: its sort column, its search, or the address.
        client.invalidateQueries({
          queryKey: [...keys.stores(projectId), "list"],
          predicate: (query) => {
            const filters = (query.queryKey[4] ?? {}) as StoreFilters;
            return moved || touched.has(filters.sort ?? "store_name") || Boolean(filters.q);
          },
        }),
      ]);
    },
  });
}

/** Keys a detail PATCH changes, with extra fields spelled as the list sorts them (`fields.dma`). */
export function editedKeys(body: StoreDetailsUpdate): Set<string> {
  const keysTouched = new Set(Object.keys(body).filter((key) => key !== "fields"));
  for (const key of Object.keys(body.fields ?? {})) keysTouched.add(`fields.${key}`);
  return keysTouched;
}

/** Progress edits are optimistic: lists, detail, pins and the routes bundle update at once and roll back on error. */
export function useUpdateProgress(projectId: string) {
  const client = useQueryClient();
  const store = useStoreStopInCaches(projectId);
  return useMutation({
    mutationFn: ({ uid, body }: { uid: string; body: ProgressUpdate }) =>
      storesApi.updateProgress(projectId, uid, body),
    onMutate: async ({ uid, body }) => {
      await Promise.all([
        client.cancelQueries({ queryKey: keys.stores(projectId) }),
        client.cancelQueries({ queryKey: keys.routes(projectId) }),
      ]);
      const lists = client.getQueriesData<StopPages>({ queryKey: [...keys.stores(projectId), "list"] });
      const pins = client.getQueriesData<Pin[]>({ queryKey: [...keys.stores(projectId), "pins"] });
      const detail = client.getQueryData<Stop>(keys.store(projectId, uid));
      const routes = client.getQueryData<RoutesBundle>(keys.routes(projectId));
      const patch = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)) as Partial<Stop>;
      for (const [key, data] of lists) client.setQueryData(key, patchStopInPages(data, uid, patch));
      for (const [key, data] of pins) client.setQueryData(key, patchPin(data, uid, patch));
      if (detail) client.setQueryData(keys.store(projectId, uid), { ...detail, ...patch });
      if (routes) client.setQueryData(keys.routes(projectId), patchStopInRoutes(routes, uid, patch));
      return { lists, pins, detail, routes };
    },
    onError: (_error, { uid }, context) => {
      for (const [key, data] of context?.lists ?? []) client.setQueryData(key, data);
      for (const [key, data] of context?.pins ?? []) client.setQueryData(key, data);
      if (context?.detail) client.setQueryData(keys.store(projectId, uid), context.detail);
      if (context?.routes) client.setQueryData(keys.routes(projectId), context.routes);
    },
    onSuccess: (stop) => store(stop),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: [...keys.stores(projectId), "pins"] }),
        client.invalidateQueries({ queryKey: keys.routes(projectId) }),
      ]),
  });
}

export function useAppendStores(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: AppendStops) => storesApi.append(projectId, body),
    // `keys.projects` is the prefix of both the dashboard list and everything under this project.
    onSuccess: () => client.invalidateQueries({ queryKey: keys.projects }),
  });
}

export const storeExportUrl = storesApi.exportUrl;
