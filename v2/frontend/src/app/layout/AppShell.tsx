import { Link, Outlet, useLocation } from "react-router";
import { HealthBadge } from "@/app/layout/HealthBadge";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Projects", match: (path: string) => path === "/" || path.startsWith("/projects") },
  { to: "/planner", label: "Route Planner", match: (path: string) => path.startsWith("/planner") },
];

export function AppShell() {
  const { pathname } = useLocation();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b bg-white/95 px-6 py-3 shadow-sm backdrop-blur">
        <div className="flex flex-wrap items-center gap-6">
          <Link to="/" className="font-display text-3xl leading-none tracking-[4px]">
            <span className="text-brand">DOLPHIN</span> <span>TRACKER</span>
          </Link>
          <nav aria-label="Main" className="flex gap-1">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                aria-current={item.match(pathname) ? "page" : undefined}
                className={cn(
                  "rounded-md px-3 py-1.5 font-mono text-xs font-semibold uppercase tracking-wider",
                  item.match(pathname) ? "bg-brand text-white" : "text-slate-600 hover:bg-slate-100",
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <HealthBadge />
      </header>
      <main className="mx-auto max-w-[1900px] px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
}
