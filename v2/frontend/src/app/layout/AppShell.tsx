import { Link, Outlet, useLocation } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { HealthBadge } from "@/app/layout/HealthBadge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ROLE_LABEL, ROLES, useMe } from "@/lib/auth/me";
import { useQuery } from "@tanstack/react-query";
import { TechnicianHome } from "@/features/technician/TechnicianHome";
import { api } from "@/lib/api/client";
import type { NameEntry, Page, Permission } from "@/lib/api/types";
import { getDevInstaller, profilePicture, setDevInstaller, setDevRole, signOut } from "@/lib/auth/token";
import { cn } from "@/lib/utils";

const NAV: { to: string; label: string; match: (path: string) => boolean; permission?: Permission }[] = [
  { to: "/", label: "Projects", match: (path: string) => path === "/" || path.startsWith("/projects") },
  { to: "/planner", label: "Route Planner", match: (path: string) => path.startsWith("/planner") },
  { to: "/installers", label: "Installers", match: (path: string) => path.startsWith("/installers") },
  // Shown only to those who may log a visit (the page offers nothing else).
  { to: "/log-visit", label: "Log Visit", match: (path: string) => path.startsWith("/log-visit"), permission: "visits.log" },
];

/** The signed-in person's Google photo, or their initials on the brand colour when there is none. */
function Avatar({ photo, name, initials, className }: { photo?: string; name: string; initials: string; className?: string }) {
  return photo ? (
    <img src={photo} alt={`${name}'s profile photo`} referrerPolicy="no-referrer" className={cn("shrink-0 rounded-full object-cover", className)} />
  ) : (
    <span aria-hidden className={cn("flex shrink-0 items-center justify-center rounded-full bg-brand font-semibold text-white", className)}>
      {initials || "?"}
    </span>
  );
}

/** Who is signed in. Without a login (local work) the role is a picker, to see the app as each role does. */
function WhoAmI() {
  const me = useMe().data;
  const client = useQueryClient();
  const local = me?.id === "local";
  // Without a login, "View as Technician" needs to be someone: the Installers list, read as an admin would.
  const installers = useQuery({
    queryKey: ["dev", "installers"],
    queryFn: () => api<Page<NameEntry>>("/lists/installers", { query: { limit: 500 }, headers: { "X-Dev-Role": "super_admin" } }),
    enabled: local && me?.role === "technician",
  });
  // The Google profile photo from the sign-in, like the other Dolphin apps show it; initials when there is none.
  const photo = useQuery({ queryKey: ["me", "picture", me?.id ?? ""], queryFn: profilePicture, enabled: Boolean(me) && !local, staleTime: Infinity });
  if (!me) return null;
  const shownName = me.name || me.email;
  const initials = shownName.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("");
  return (
    <div className="flex items-center gap-2 text-xs" aria-label="Signed in as">
      {local ? (
        <label className="flex items-center gap-1.5 text-slate-500">
          View as
          <select
            aria-label="View as role"
            className="h-7 rounded-md border bg-white px-1.5 text-xs font-medium text-slate-800"
            value={me.role}
            onChange={(event) => {
              setDevRole(event.target.value === "super_admin" ? null : event.target.value);
              void client.invalidateQueries(); // everything is read again as that role
            }}
          >
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABEL[role]}
              </option>
            ))}
          </select>
          {me.role === "technician" && (
            <select
              aria-label="View as installer"
              className="h-7 max-w-40 rounded-md border bg-white px-1.5 text-xs font-medium text-slate-800"
              value={getDevInstaller() ?? ""}
              onChange={(event) => {
                setDevInstaller(event.target.value || null);
                void client.invalidateQueries();
              }}
            >
              <option value="">Choose an installer</option>
              {(installers.data?.items ?? []).map((item) => (
                <option key={item.value} value={item.value}>
                  {item.value}
                </option>
              ))}
            </select>
          )}
        </label>
      ) : (
        // Like Keystone: the photo is the button; who it is, their role here and Sign out are behind it.
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Account: ${shownName}`}
              className="rounded-full outline-none ring-2 ring-transparent ring-offset-2 transition hover:ring-brand/40 focus-visible:ring-brand data-[state=open]:ring-brand"
            >
              <Avatar photo={photo.data} name={shownName} initials={initials} className="size-9 text-xs" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72 p-0">
            <div className="flex items-center gap-3 p-4">
              <Avatar photo={photo.data} name={shownName} initials={initials} className="size-11 text-sm" />
              <div className="min-w-0 space-y-1">
                <p className="truncate text-sm font-semibold text-slate-900">{shownName}</p>
                {me.email && me.email !== shownName && <p className="truncate text-xs text-slate-500">{me.email}</p>}
                <span className="inline-block rounded border border-brand/30 bg-brand/5 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-brand">
                  Tracker {ROLE_LABEL[me.role]}
                </span>
              </div>
            </div>
            <DropdownMenuSeparator className="m-0" />
            <DropdownMenuItem className="m-1 gap-2 px-3 py-2" onSelect={() => void signOut()}>
              <LogOut /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export function AppShell() {
  const { pathname } = useLocation();
  const me = useMe().data;
  return (
    <div className="min-h-screen">
      {me?.acting_by && (
        <div role="status" className="bg-amber-500 px-6 py-1.5 text-center text-xs font-medium text-white">
          {me.acting_by} is signed in as {me.name || me.email} ({ROLE_LABEL[me.role]}). Changes are recorded under both names.
        </div>
      )}
      <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b bg-white/95 px-6 py-3 shadow-sm backdrop-blur">
        <div className="flex flex-wrap items-center gap-6">
          <Link to="/" className="font-display text-3xl leading-none tracking-[4px]">
            <span className="text-brand">DOLPHIN</span> <span className="text-brand-magenta">TRACKER</span>
          </Link>
          <nav aria-label="Main" className="flex gap-1">
            {(me?.role === "technician" ? [] : NAV.filter((item) => !item.permission || me?.permissions.includes(item.permission))).map((item) => (
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
        <div className="flex items-center gap-4">
          <WhoAmI />
          <HealthBadge />
        </div>
      </header>
      <main className="mx-auto max-w-[1900px] px-6 py-6">
        {me?.role === "technician" ? (
          <TechnicianHome />
        ) : (
          <Outlet />
        )}
      </main>
    </div>
  );
}
