import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { keys, type StorePageParams } from "@/lib/api/keys";
import { storesApi, type StoreFilters } from "@/lib/api/resources";
import {
  deriveStatus,
  type AppendStops,
  type StoreAdd,
  type Pin,
  type ProgressUpdate,
  type RoutesBundle,
  type ScreenInput,
  type Stop,
  type StoreDetailsUpdate,
  type StorePage,
} from "@/lib/api/types";
import { patchPin, patchStopInPage, patchStopInRoutes } from "@/features/stores/cache";

export const STORE_PAGE_SIZES = [15, 20, 30, 50] as const;
export const DEFAULT_STORE_PAGE_SIZE = 20;

/** One numbered page of the filtered, sorted stores (with the total), optionally only those in the map view. */
export function useStoreList(projectId: string, filters: StoreFilters, page: StorePageParams, enabled = true) {
  return useQuery({
    queryKey: keys.storeList(projectId, filters, page),
    queryFn: () => storesApi.list(projectId, filters, page),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** One numbered page of the screens (the Screens view), one row each; off while the Stores view shows. */
export function useScreenList(projectId: string, filters: StoreFilters, page: StorePageParams, enabled = true) {
  return useQuery({
    queryKey: keys.screenList(projectId, filters, page),
    queryFn: () => storesApi.screens(projectId, filters, page),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** The five stores closest to what is typed in the search (ExtID, name, address), for its drop-down. */
export function useStoreSuggestions(projectId: string, q: string) {
  return useQuery({
    queryKey: keys.storeList(projectId, { q, sort: "store_name", dir: "asc" }, { offset: 0, limit: 5, bounds: null }),
    queryFn: () => storesApi.list(projectId, { q, sort: "store_name", dir: "asc" }, { offset: 0, limit: 5, bounds: null }),
    enabled: q.length > 0,
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
/** Stores (or screens) of every status per state under the active filters, most first; the State filter itself is ignored. */
export function useStoresByState(projectId: string, filters: StoreFilters, unit: "stores" | "screens" = "stores") {
  return useQuery({
    queryKey: [...keys.byState(projectId, { ...filters, state: [] }), unit],
    queryFn: () => storesApi.byState(projectId, { ...filters, state: [] }, false, unit),
    placeholderData: keepPreviousData,
  });
}

/** Installed hardware under the filters, for the Hardware cost chart (every filter applies, State included). */
export function useStoreHardware(projectId: string, filters: StoreFilters) {
  return useQuery({
    queryKey: keys.hardware(projectId, filters),
    queryFn: () => storesApi.hardware(projectId, filters),
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
/** Enter the ExtID of a store that has none (added from the Dolphin data); fixed once saved. */
/** Delete a store for good (admins). Refreshes the dashboard's counts and everything under the project, except the
 *  deleted store's own entry: its window is still closing, and refetching it would only show a 404. */
export function useDeleteStore(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (uid: string) => storesApi.remove(projectId, uid),
    onSuccess: (_result, uid) => {
      const gone = JSON.stringify(keys.store(projectId, uid));
      return client.invalidateQueries({
        queryKey: keys.projects,
        predicate: (query) => JSON.stringify(query.queryKey) !== gone,
      });
    },
  });
}

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

/** Add one store by hand; the server checks it like a sheet row (ExtID, name, address; duplicates; Google). */
export function useAddStore(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: StoreAdd) => storesApi.add(projectId, body),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.projects }),
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
