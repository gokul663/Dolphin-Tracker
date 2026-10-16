import { useMutation, useQuery } from "@tanstack/react-query";
import { keys } from "@/lib/api/keys";
import { configApi, placesApi } from "@/lib/api/resources";

export function useValidateAddress() {
  return useMutation({ mutationFn: (address: string) => placesApi.validate(address) });
}

export function useMapsConfig() {
  return useQuery({ queryKey: keys.mapsConfig, queryFn: configApi.maps, staleTime: Infinity });
}

/** The schema a new project starts with (backend §3.1 default), for the import wizard's column mapping. */
export function useDefaultFieldSchema() {
  return useQuery({ queryKey: keys.defaultFieldSchema, queryFn: configApi.defaultFieldSchema, staleTime: Infinity });
}
