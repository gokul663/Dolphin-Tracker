import { Database } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useHealth } from "@/lib/api/health";
import { cn } from "@/lib/utils";

/** Shown only when something is wrong: the API or its database cannot be reached (polled every 15 s). Connected
 *  is the normal state and says nothing. */
export function HealthBadge() {
  const health = useHealth();
  const state = health.isPending ? "checking" : health.isError ? "offline" : health.data.db ? "ok" : "db";
  if (state === "ok" || state === "checking") return null;
  const text = { offline: "API OFFLINE", db: "DATABASE UNREACHABLE" }[state];
  return (
    <Badge
      variant="outline"
      role="status"
      title="API and database status, polled every 15 s"
      className={cn(
        "gap-1.5 font-mono text-[10px] tracking-wider",
        "border-rose-500/50 bg-rose-50 text-rose-700",
      )}
    >
      <Database size={11} />
      <span className="inline-block size-1.5 rounded-full bg-rose-500" />
      {text}
    </Badge>
  );
}
