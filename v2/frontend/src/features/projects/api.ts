import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { keys } from "@/lib/api/keys";
import { projectsApi } from "@/lib/api/resources";
import { ApiError, type Page, type Project, type ProjectSummary, type ProjectUpdate } from "@/lib/api/types";

const PAGE_SIZE = 200;

/** Every project, paging through the API (the dashboard aggregates across all of them). */
export async function fetchAllProjects(): Promise<ProjectSummary[]> {
  const all: ProjectSummary[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<ProjectSummary> = await projectsApi.list({ limit: PAGE_SIZE, cursor });
    all.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  return all;
}

export function useAllProjects() {
  return useQuery({ queryKey: keys.projectList(PAGE_SIZE), queryFn: fetchAllProjects });
}

/** Project META; polls every 2 s while a routing build is running so the banner and tabs update by themselves. */
export function useProject(projectId: string) {
  return useQuery({
    queryKey: keys.project(projectId),
    queryFn: () => projectsApi.get(projectId),
    refetchInterval: (query) => (query.state.data?.routing_status === "building" ? 2_000 : false),
  });
}

/**
 * A finished build changes routes, the stores list (installer/day columns), pins and the open drawer. When the
 * project's routing_status leaves "building", invalidate everything under the project, whichever tab is open.
 */
export function useRefreshWhenRoutingFinishes(project: Project | undefined) {
  const client = useQueryClient();
  const previous = useRef(project?.routing_status);
  useEffect(() => {
    if (!project) return;
    if (previous.current === "building" && project.routing_status !== "building") {
      void client.invalidateQueries({ queryKey: keys.project(project.id) });
    }
    previous.current = project.routing_status;
  }, [project?.routing_status, project?.id, client]);
}

export function useRoutes(projectId: string, enabled = true) {
  return useQuery({ queryKey: keys.routes(projectId), queryFn: () => projectsApi.routes(projectId), enabled });
}

function useInvalidateProject(projectId: string) {
  const client = useQueryClient();
  return () => Promise.all([
    client.invalidateQueries({ queryKey: keys.project(projectId) }),
    client.invalidateQueries({ queryKey: keys.projects, exact: false, refetchType: "active" }),
  ]);
}

export function useCreateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: projectsApi.create,
    onSuccess: () => client.invalidateQueries({ queryKey: keys.projects }),
  });
}

export function useUpdateProject(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: ProjectUpdate) => projectsApi.update(projectId, body),
    onSuccess: (project: Project) => {
      client.setQueryData(keys.project(projectId), project);
      return client.invalidateQueries({ queryKey: keys.projects });
    },
    // A 409 means our expected_version is stale: refetch so the retry sends the current one. `keys.projects`
    // covers the dashboard list and the project. Used by the edit dialog, Settings details and the schema editor.
    onError: (error) =>
      error instanceof ApiError && error.status === 409 ? client.invalidateQueries({ queryKey: keys.projects }) : undefined,
  });
}

export function useDeleteProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, confirm }: { id: string; confirm: string }) => projectsApi.remove(id, confirm),
    onSuccess: (_data, { id }) => {
      client.removeQueries({ queryKey: keys.project(id) });
      return client.invalidateQueries({ queryKey: keys.projects });
    },
  });
}

/** Routing jobs: add installer, rebalance, recluster. The project query then polls until `ready`. */
export function useRoutingJob(projectId: string) {
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: (action: { kind: "add_installer"; name: string } | { kind: "rebalance" } | { kind: "recluster" }) => {
      if (action.kind === "add_installer") return projectsApi.addInstaller(projectId, action.name);
      if (action.kind === "rebalance") return projectsApi.rebalance(projectId);
      return projectsApi.recluster(projectId);
    },
    onSuccess: invalidate,
  });
}

export function useRenameInstaller(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ oldName, newName }: { oldName: string; newName: string }) =>
      projectsApi.renameInstaller(projectId, oldName, newName),
    onSuccess: (project) => {
      client.setQueryData(keys.project(projectId), project);
      return client.invalidateQueries({ queryKey: keys.project(projectId) });
    },
  });
}

export function useReassignStop(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ uid, installer }: { uid: string; installer: string }) =>
      projectsApi.reassign(projectId, uid, installer),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.project(projectId) }),
  });
}
