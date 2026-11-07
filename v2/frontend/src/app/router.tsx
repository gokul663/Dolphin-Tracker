import { lazy, Suspense, type ReactNode } from "react";
import { createBrowserRouter, Navigate } from "react-router";
import { AppShell } from "@/app/layout/AppShell";
import { DashboardPage } from "@/features/dashboard/DashboardPage";
import { ProjectPage } from "@/features/projects/ProjectPage";

// Tabs are split out so the dashboard does not download the map, table and planner code.
const StoresTab = lazy(() => import("@/features/stores/StoresTab").then((m) => ({ default: m.StoresTab })));
const PlannerHome = lazy(() => import("@/features/planner/PlannerHome").then((m) => ({ default: m.PlannerHome })));
const PlanWizard = lazy(() => import("@/features/planner/PlanWizard").then((m) => ({ default: m.PlanWizard })));
const PlanPage = lazy(() => import("@/features/planner/PlanPage").then((m) => ({ default: m.PlanPage })));
const StoresFullPage = lazy(() => import("@/features/stores/StoresFullPage").then((m) => ({ default: m.StoresFullPage })));
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
          // Routes moved to the Route Planner (ROUTE-PLANNER §2); old links land on the stores.
          { path: "routes", element: <Navigate to="../stores" replace /> },
          { path: "settings", element: tab(<SettingsTab />) },
        ],
      },
      // The Stores tab's map and chart on pages of their own (opened in a new tab, filters in the link).
      { path: "projects/:projectId/map", element: tab(<StoresFullPage view="map" />) },
      { path: "projects/:projectId/states", element: tab(<StoresFullPage view="states" />) },
      { path: "planner", element: tab(<PlannerHome />) },
      { path: "planner/new", element: tab(<PlanWizard />) },
      { path: "planner/:planId", element: tab(<PlanPage />) },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);
