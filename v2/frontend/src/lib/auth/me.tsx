import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { keys } from "@/lib/api/keys";
import type { Me, Permission, Role } from "@/lib/api/types";

export const ROLE_LABEL: Record<Role, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  operator: "Operator",
  viewer: "Viewer",
  technician: "Technician",
};
export const ROLES = Object.keys(ROLE_LABEL) as Role[];

/** Who is signed in, their role and what it lets them do. The server decides (and checks every call); the screens
 *  only use this to hide what would be refused. */
export function useMe(enabled = true) {
  return useQuery({ queryKey: keys.me, queryFn: () => api<Me>("/me"), staleTime: 5 * 60_000, retry: false, enabled });
}

/** Whether the signed-in person may do this. False until it is known. */
export function useCan(permission: Permission): boolean {
  return useMe().data?.permissions.includes(permission) ?? false;
}

/** Shows its children only to someone with the permission. */
export function Can({ permission, children, otherwise = null }: { permission: Permission; children: ReactNode; otherwise?: ReactNode }) {
  return <>{useCan(permission) ? children : otherwise}</>;
}
