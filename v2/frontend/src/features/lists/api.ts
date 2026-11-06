import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { keys } from "@/lib/api/keys";
import { listsApi } from "@/lib/api/resources";
import type { CategoryInput, NameListKind } from "@/lib/api/types";

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
