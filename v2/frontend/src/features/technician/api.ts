import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { keys } from "@/lib/api/keys";
import type { MyProfileUpdate, MyRoute, NameEntry } from "@/lib/api/types";

/** The signed-in technician's own days in every active plan, and their entry on the Installers page. */
export function useMyRoute() {
  return useQuery({ queryKey: keys.myRoute, queryFn: () => api<MyRoute>("/my/route"), refetchInterval: 5 * 60_000 });
}

/** Their additional phone and shipping address (the rest is an Admin's to change). */
export function useSaveMyProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: MyProfileUpdate) => api<NameEntry>("/my/profile", { method: "PUT", body }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.myRoute }),
  });
}
