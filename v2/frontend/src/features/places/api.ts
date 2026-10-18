import { useMutation, useQuery } from "@tanstack/react-query";
import { keys } from "@/lib/api/keys";
import { configApi, placesApi } from "@/lib/api/resources";

export function useValidateAddress() {
  return useMutation({ mutationFn: (address: string) => placesApi.validate(address) });
}

export function useMapsConfig() {
  return useQuery({ queryKey: keys.mapsConfig, queryFn: configApi.maps, staleTime: Infinity });
}

/** The store field registry (labels, groups, kinds) in drawer order; it never changes while the app runs. */
export function useStoreFields() {
  return useQuery({ queryKey: keys.storeFields, queryFn: configApi.storeFields, staleTime: Infinity });
}

