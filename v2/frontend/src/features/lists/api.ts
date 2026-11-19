import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { keys } from "@/lib/api/keys";
import { listsApi } from "@/lib/api/resources";
import type { CategoryInput, InstallerSave, NameListKind } from "@/lib/api/types";

/** Installer or Dolphin manager names, alphabetical. A typed name that is not listed is added when it is used. */
export function useNames(kind: NameListKind) {
  return useQuery({
    queryKey: keys.names(kind),
    queryFn: async () => (await listsApi.names(kind)).items.map((entry) => entry.value),
    staleTime: 60_000,
  });
}

export function useAddName(kind: NameListKind) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (value: string) => listsApi.addName(kind, value),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.names(kind) }),
  });
}

export function useRemoveName(kind: NameListKind) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (value: string) => listsApi.removeName(kind, value),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.names(kind) }),
  });
}

/** The installers with how to reach them (the Installers page), alphabetical. */
export function useInstallers() {
  return useQuery({ queryKey: keys.installers, queryFn: async () => (await listsApi.names("installers")).items, staleTime: 60_000 });
}

/** Add an installer or change their details; the name pick lists follow. */
export function useSaveInstaller() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ name, body }: { name: string; body: Partial<InstallerSave> }) => listsApi.saveInstaller(name, body),
    // A rename also changes the store records and route plans that name the installer.
    onSuccess: (saved, { name }) =>
      Promise.all([
        client.invalidateQueries({ queryKey: keys.names("installers") }),
        ...(saved.value !== name ? [client.invalidateQueries({ queryKey: keys.projects }), client.invalidateQueries({ queryKey: keys.routePlans })] : []),
      ]),
  });
}

/** What each installer has across every project, and the names on stores that match no installer. */
export function useInstallerWork() {
  return useQuery({ queryKey: keys.installerWork, queryFn: listsApi.installerWork, staleTime: 30_000 });
}

/** Bring matching store records to the Installers list's spelling; every project's stores follow. */
export function useSyncInstallers() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: listsApi.syncInstallers,
    onSuccess: () => Promise.all([client.invalidateQueries({ queryKey: keys.names("installers") }), client.invalidateQueries({ queryKey: keys.projects })]),
  });
}

/** Visit categories → subcategories (the offline portal's nine by default). */
export function useCategories() {
  return useQuery({ queryKey: keys.categories, queryFn: listsApi.categories, staleTime: 5 * 60_000 });
}

export function useSaveCategories() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (categories: CategoryInput[]) => listsApi.saveCategories(categories),
    onSuccess: (saved) => client.setQueryData(keys.categories, saved),
  });
}
