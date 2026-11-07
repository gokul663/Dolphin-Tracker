import { useMutation, useQuery } from "@tanstack/react-query";
import { keys } from "@/lib/api/keys";
import { configApi, placesApi } from "@/lib/api/resources";

export function useValidateAddress() {
  return useMutation({
    mutationFn: (input: string | { address: string; name?: string }) =>
      typeof input === "string" ? placesApi.validate(input) : placesApi.validate(input.address, input.name),
  });
}

/** Google Search's places for a store (name + address), to pick the right one by hand. */
export function useSearchPlaces() {
  return useMutation({ mutationFn: ({ address, name }: { address: string; name?: string }) => placesApi.search(address, name) });
}

export function useMapsConfig() {
  return useQuery({ queryKey: keys.mapsConfig, queryFn: configApi.maps, staleTime: Infinity });
}

/** The store field registry (labels, groups, kinds) in drawer order; it never changes while the app runs. */
export function useStoreFields() {
  return useQuery({ queryKey: keys.storeFields, queryFn: configApi.storeFields, staleTime: Infinity });
}

