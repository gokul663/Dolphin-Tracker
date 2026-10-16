import { useQuery } from "@tanstack/react-query";
import { keys } from "@/lib/api/keys";
import { healthApi } from "@/lib/api/resources";

export function useHealth() {
  return useQuery({ queryKey: keys.health, queryFn: healthApi.get, refetchInterval: 15_000 });
}
