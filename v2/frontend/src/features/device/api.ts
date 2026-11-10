import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { keys } from "@/lib/api/keys";
import { deviceSyncApi } from "@/lib/api/resources";
import type { OverwriteField, Project, ReviewAdd } from "@/lib/api/types";

/** The PA names in the device report's newest day (Settings' "Sync with PA"). */
export function useDevicePas(enabled = true) {
  return useQuery({ queryKey: keys.devicePas, queryFn: deviceSyncApi.pas, enabled, staleTime: 10 * 60_000, retry: 1 });
}

/** Everything under the project (KPIs, stores, pins, the open store, the review list) after a sync-side change. */
function useRefreshProject(projectId: string) {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: keys.project(projectId) });
}

/**
 * On opening a project with a PA chosen: sync when the report has a newer day than the last sync (the server
 * checks, so this is cheap when nothing changed). Once per project per page load; failures stay quiet here and show
 * in Settings' "Sync now".
 */
export function useAutoDeviceSync(project: Project | undefined) {
  const refresh = useRefreshProject(project?.id ?? "");
  const tried = useRef<string>("");
  const sync = useMutation({
    mutationFn: (projectId: string) => deviceSyncApi.sync(projectId, true),
    onSuccess: (result) => (result.synced ? refresh() : undefined),
  });
  const target = project?.device_pa ? `${project.id}:${project.device_pa}` : "";
  useEffect(() => {
    if (!project || !target || tried.current === target) return;
    tried.current = target;
    sync.mutate(project.id);
  }, [target]); // once per project + PA
  return sync;
}

export function useSyncNow(projectId: string) {
  const refresh = useRefreshProject(projectId);
  return useMutation({ mutationFn: () => deviceSyncApi.sync(projectId), onSuccess: () => refresh() });
}

export function useDeviceReview(projectId: string, page: { limit: number; cursor: string | null }, includeSnoozed: boolean, enabled = true) {
  return useQuery({
    queryKey: [...keys.deviceReview(projectId), page, includeSnoozed],
    queryFn: () => deviceSyncApi.review(projectId, { ...page, includeSnoozed }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** Add a reviewed record. A 422 with `suggestions` means Google could not verify the address (or the report has
 *  none): send `address`, a picked `place`, or `add_anyway`. */
export function useAddReviewed(projectId: string) {
  const refresh = useRefreshProject(projectId);
  return useMutation({
    mutationFn: ({ key, body = {} }: { key: string; body?: Partial<ReviewAdd> }) => deviceSyncApi.add(projectId, key, body),
    onSuccess: () => refresh(),
  });
}

export function useSnoozeReviewed(projectId: string) {
  const refresh = useRefreshProject(projectId);
  return useMutation({ mutationFn: (key: string) => deviceSyncApi.snooze(projectId, key), onSuccess: () => refresh() });
}

/** Copy report values into the store's own fields: one store (`uid`) or every synced store. */
export function useOverwriteFromDevice(projectId: string) {
  const refresh = useRefreshProject(projectId);
  return useMutation({
    mutationFn: ({ uid, fields }: { uid?: string; fields: OverwriteField[] }) =>
      uid ? deviceSyncApi.overwriteStore(projectId, uid, fields) : deviceSyncApi.overwriteAll(projectId, fields),
    onSuccess: () => refresh(),
  });
}

export function useIgnoreDeviceAlert(projectId: string) {
  const refresh = useRefreshProject(projectId);
  return useMutation({ mutationFn: (uid: string) => deviceSyncApi.ignoreAlert(projectId, uid), onSuccess: () => refresh() });
}
