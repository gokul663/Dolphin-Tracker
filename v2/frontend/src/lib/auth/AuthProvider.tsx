import { createContext, useContext, type ReactNode } from "react";

export interface AuthUser {
  id: string;
  name: string;
  roles: string[];
}

interface AuthContextValue {
  user: AuthUser | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** No-op provider until Cognito arrives (Phase 6). Components use `useAuth()` so nothing changes later. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const value: AuthContextValue = {
    user: null,
    signIn: async () => {},
    signOut: async () => {},
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
