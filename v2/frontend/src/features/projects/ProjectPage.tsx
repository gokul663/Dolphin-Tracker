import { NavLink, Outlet, useParams } from "react-router";
import { cn } from "@/lib/utils";

const TABS = [
  { to: "stores", label: "Stores" },
  { to: "routes", label: "Routes" },
  { to: "settings", label: "Settings" },
];

export function ProjectPage() {
  const { projectId } = useParams();
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="font-display text-2xl tracking-[3px]">Project {projectId}</h1>
        <nav className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) =>
                cn(
                  "rounded-md px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider",
                  isActive ? "bg-brand text-white" : "text-slate-600 hover:bg-slate-100",
                )
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </div>
      <Outlet />
    </section>
  );
}
