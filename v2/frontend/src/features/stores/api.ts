import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { keys, type StorePageParams } from "@/lib/api/keys";
import { storesApi, type StoreFilters } from "@/lib/api/resources";
import {
  deriveStatus,
  type AppendStops,
  type Pin,
  type ProgressUpdate,
  type RoutesBundle,
  type ScreenInput,
  type Stop,
  type StoreDetailsUpdate,
  type StorePage,
} from "@/lib/api/types";
import { patchPin, patchStopInPage, patchStopInRoutes } from "@/features/stores/cache";

export const STORE_PAGE_SIZES = [20, 30, 50] as const;
export const DEFAULT_STORE_PAGE_SIZE = 20;

/** One numbered page of the filtered, sorted stores (with the total), optionally only those in the map view. */
export function useStoreList(projectId: string, filters: StoreFilters, page: StorePageParams) {
  return useQuery({
    queryKey: keys.storeList(projectId, filters, page),
    queryFn: () => storesApi.list(projectId, filters, page),
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

/** Values per filter with counts, under the other active filters (greys out filters with nothing to pick). */
export function useFilterOptions(projectId: string, filters: StoreFilters) {
  return useQuery({
    queryKey: keys.storeFacets(projectId, filters),
    queryFn: () => storesApi.filters(projectId, filters),
    placeholderData: keepPreviousData,
  });
}

/** Pending stores per state, top 10, under every active filter except State. */
/** Every state with upcoming installs (stores, or screens), most first; the State filter itself is ignored. */
export function useStoresByState(projectId: string, filters: StoreFilters, unit: "stores" | "screens" = "stores") {
  return useQuery({
    queryKey: [...keys.byState(projectId, { ...filters, state: [] }), unit],
    queryFn: () => storesApi.byState(projectId, { ...filters, state: [] }, true, unit),
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
    client.setQueriesData<StorePage>({ queryKey: [...keys.stores(projectId), "list"] }, (data) =>
      patchStopInPage(data, stop.uid, stop),
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

type Client = ReturnType<typeof useQueryClient>;
type Snapshot = {
  lists: [readonly unknown[], StorePage | undefined][];
  pins: [readonly unknown[], Pin[] | undefined][];
  detail: Stop | undefined;
  routes: RoutesBundle | undefined;
};

/** Patch one stop in every cached view (lists, pins, detail, routes bundle) and return what to roll back to. */
async function applyOptimistic(client: Client, projectId: string, uid: string, patch: Partial<Stop>): Promise<Snapshot> {
  await Promise.all([
    client.cancelQueries({ queryKey: keys.stores(projectId) }),
    client.cancelQueries({ queryKey: keys.routes(projectId) }),
  ]);
  const snapshot: Snapshot = {
    lists: client.getQueriesData<StorePage>({ queryKey: [...keys.stores(projectId), "list"] }),
    pins: client.getQueriesData<Pin[]>({ queryKey: [...keys.stores(projectId), "pins"] }),
    detail: client.getQueryData<Stop>(keys.store(projectId, uid)),
    routes: client.getQueryData<RoutesBundle>(keys.routes(projectId)),
  };
  for (const [key, data] of snapshot.lists) client.setQueryData(key, patchStopInPage(data, uid, patch));
  for (const [key, data] of snapshot.pins) client.setQueryData(key, patchPin(data, uid, patch));
  if (snapshot.detail) client.setQueryData(keys.store(projectId, uid), { ...snapshot.detail, ...patch });
  if (snapshot.routes) client.setQueryData(keys.routes(projectId), patchStopInRoutes(snapshot.routes, uid, patch));
  return snapshot;
}

function rollback(client: Client, projectId: string, uid: string, snapshot: Snapshot | undefined) {
  for (const [key, data] of snapshot?.lists ?? []) client.setQueryData(key, data);
  for (const [key, data] of snapshot?.pins ?? []) client.setQueryData(key, data);
  if (snapshot?.detail) client.setQueryData(keys.store(projectId, uid), snapshot.detail);
  if (snapshot?.routes) client.setQueryData(keys.routes(projectId), snapshot.routes);
}

function settle(client: Client, projectId: string) {
  return Promise.all([
    client.invalidateQueries({ queryKey: [...keys.stores(projectId), "pins"] }),
    client.invalidateQueries({ queryKey: keys.routes(projectId) }),
  ]);
}

/** Progress edits are optimistic: lists, detail, pins and the routes bundle update at once and roll back on error. */
/** Enter the IBC# of a store that has none (added from the Dolphin data); fixed once saved. */
export function useSetExternalId(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ uid, externalId }: { uid: string; externalId: string }) => storesApi.setExternalId(projectId, uid, externalId),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.project(projectId) }), // KPIs, list, the store
  });
}

export function useUpdateProgress(projectId: string) {
  const client = useQueryClient();
  const store = useStoreStopInCaches(projectId);
  return useMutation({
    mutationFn: ({ uid, body }: { uid: string; body: ProgressUpdate }) =>
      storesApi.updateProgress(projectId, uid, body),
    onMutate: ({ uid, body }) => {
      const patch = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)) as Partial<Stop>;
      return applyOptimistic(client, projectId, uid, patch);
    },
    onError: (_error, { uid }, snapshot) => rollback(client, projectId, uid, snapshot),
    onSuccess: (stop) => store(stop),
    onSettled: () => settle(client, projectId),
  });
}

/** Replace a store's screen rows (PUT …/screens). Optimistic: the rows and the derived status show at once. */
export function useUpdateScreens(projectId: string) {
  const client = useQueryClient();
  const store = useStoreStopInCaches(projectId);
  return useMutation({
    mutationFn: ({ uid, screens, updatedBy = "" }: { uid: string; screens: ScreenInput[]; updatedBy?: string }) =>
      storesApi.updateScreens(projectId, uid, { screens, updated_by: updatedBy }),
    onMutate: ({ uid, screens }) => {
      const status = deriveStatus(screens.map((screen) => screen.status ?? "Upcoming"));
      const rows = screens.map((screen, index) => ({ id: screen.id ?? `pending-${index}`, ...screen })) as Stop["screens"];
      return applyOptimistic(client, projectId, uid, { screens: rows, status });
    },
    onError: (_error, { uid }, snapshot) => rollback(client, projectId, uid, snapshot),
    onSuccess: (stop) => store(stop),
    onSettled: () => settle(client, projectId),
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
