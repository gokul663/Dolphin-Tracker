import { createBrowserRouter, Navigate } from "react-router";
import { AppShell } from "@/app/layout/AppShell";
import { DashboardPage } from "@/features/dashboard/DashboardPage";
import { ProjectPage } from "@/features/projects/ProjectPage";
import { StoresTab } from "@/features/stores/StoresTab";
import { RoutesTab } from "@/features/routes/RoutesTab";
import { SettingsTab } from "@/features/settings/SettingsTab";

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
          { path: "stores", element: <StoresTab /> },
          { path: "routes", element: <RoutesTab /> },
          { path: "settings", element: <SettingsTab /> },
        ],
      },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);
