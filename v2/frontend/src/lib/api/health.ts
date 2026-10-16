import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type { HealthResponse } from "@/lib/api/types";

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => api<HealthResponse>("/health"),
    refetchInterval: 15_000,
  });
}
