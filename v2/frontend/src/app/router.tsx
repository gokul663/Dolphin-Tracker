import { lazy, Suspense, type ReactNode } from "react";
import { createBrowserRouter, Navigate } from "react-router";
import { AppShell } from "@/app/layout/AppShell";
import { DashboardPage } from "@/features/dashboard/DashboardPage";
import { ProjectPage } from "@/features/projects/ProjectPage";

// Tabs are split out so the dashboard does not download the map, table and planner code.
const StoresTab = lazy(() => import("@/features/stores/StoresTab").then((m) => ({ default: m.StoresTab })));
const RoutesTab = lazy(() => import("@/features/routes/RoutesTab").then((m) => ({ default: m.RoutesTab })));
const SettingsTab = lazy(() => import("@/features/settings/SettingsTab").then((m) => ({ default: m.SettingsTab })));

const tab = (element: ReactNode) => (
  <Suspense fallback={<div className="p-6 text-center font-mono text-sm text-slate-500">Loading…</div>}>{element}</Suspense>
);

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <DashboardPage /> },
      {
        path: "projects/:projectId",
        element: <ProjectPage />,
        children: [
          { index: true, element: <Navigate to="stores" replace /> },
          { path: "stores", element: tab(<StoresTab />) },
          { path: "routes", element: tab(<RoutesTab />) },
          { path: "settings", element: tab(<SettingsTab />) },
        ],
      },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);
