import { Link, Outlet } from "react-router";
import { useHealth } from "@/lib/api/health";

export function AppShell() {
  const health = useHealth();
  const db = health.data?.db;
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-slate-200 bg-white/95 px-6 py-3 backdrop-blur">
        <Link to="/" className="font-display text-3xl tracking-[4px] leading-none">
          <span className="text-brand">ROUTE</span> <span>PLANNER</span>
        </Link>
        <span
          className="font-mono text-[10px] tracking-wider uppercase rounded border px-2 py-1"
          title="API health, polled every 15s"
        >
          API {health.isPending ? "checking…" : health.isError ? "offline" : db ? "ok · db ok" : "ok · db unreachable"}
        </span>
      </header>
      <main className="mx-auto max-w-[1900px] px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
}
