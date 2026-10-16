import { Link, Outlet } from "react-router";
import { HealthBadge } from "@/app/layout/HealthBadge";

export function AppShell() {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b bg-white/95 px-6 py-3 shadow-sm backdrop-blur">
        <Link to="/" className="font-display text-3xl leading-none tracking-[4px]">
          <span className="text-brand">ROUTE</span> <span>PLANNER</span>
        </Link>
        <HealthBadge />
      </header>
      <main className="mx-auto max-w-[1900px] px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
}
