import { Database } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useHealth } from "@/lib/api/health";
import { cn } from "@/lib/utils";

/** v1's connection badge, now for the API + DynamoDB (polled every 15 s). */
export function HealthBadge() {
  const health = useHealth();
  const state = health.isPending ? "checking" : health.isError ? "offline" : health.data.db ? "ok" : "db";
  const text = { checking: "CHECKING…", offline: "API OFFLINE", ok: "DATABASE CONNECTED", db: "DATABASE UNREACHABLE" }[state];
  return (
    <Badge
      variant="outline"
      title="API and database status, polled every 15 s"
      className={cn(
        "gap-1.5 font-mono text-[10px] tracking-wider",
        state === "ok" && "border-emerald-500/50 bg-emerald-50 text-emerald-700",
        (state === "offline" || state === "db") && "border-rose-500/50 bg-rose-50 text-rose-700",
        state === "checking" && "text-slate-500",
      )}
    >
      <Database size={11} />
      <span
        className={cn(
          "inline-block size-1.5 rounded-full",
          state === "ok" ? "animate-pulse bg-emerald-500" : state === "checking" ? "bg-slate-400" : "bg-rose-500",
        )}
      />
      {text}
    </Badge>
  );
}
