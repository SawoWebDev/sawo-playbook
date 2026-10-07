'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as client from './api';
import { api, type Role, type SessionUser } from './api';
import { usePreviewRole } from './preview-role';

interface AuthState {
  /** The user the UI works as. When a role is previewed, this carries that role and its permissions. */
  user: SessionUser | null;
  /** The signed-in user, never changed by a preview. */
  realUser: SessionUser | null;
  /** The role being previewed, or null. Only set for users who can manage roles. */
  previewRole: Role | null;
  loading: boolean;
  login: typeof client.login;
  signup: typeof client.signup;
  logout: typeof client.logout;
  /** The Admin who is signed in as this user right now, or null. */
  impersonatedBy: { id: string; name: string } | null;
  startImpersonation: typeof client.startImpersonation;
  stopImpersonation: typeof client.stopImpersonation;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const requestedPreview = usePreviewRole();
  const [rolePermissions, setRolePermissions] = useState<Record<string, string[]>>({});

  // Preview is offered only to users whose server permissions include roles.manage, as on the REACT_SITE (superadmin).
  const canPreview = !!user?.permissions.includes('roles.manage');

  useEffect(() => {
    // Every session change loads the server's authorisation context (permissions and groups) before the UI relies on it.
    // The user is set straight away, so a page never redirects while the context is still loading.
    const off = client.onSessionChange((u) => {
      if (!u) {
        setUser(null);
        return;
      }
      setUser({ ...u, permissions: [], groupIds: [] });
      client.fetchAuthContext()
        .then((ctx) => setUser((prev) => (prev && prev.id === u.id ? { ...prev, ...ctx } : prev)))
        .catch(() => undefined);
    });
    // Restore the session on page load: an impersonation kept for this tab, else the HttpOnly refresh cookie.
    client.restoreSession().finally(() => setLoading(false));
    return () => {
      off();
    };
  }, []);

  // The permissions each role holds, from the same list the Roles & Permissions page uses. Only loaded when previewing.
  useEffect(() => {
    if (!canPreview || !requestedPreview) return;
    api<{ roles: { role: string; permissions: string[] }[] }>('/roles')
      .then((r) => setRolePermissions(Object.fromEntries(r.roles.map((x) => [x.role, x.permissions]))))
      .catch(() => setRolePermissions({}));
  }, [canPreview, requestedPreview]);

  const previewRole = canPreview ? requestedPreview : null;

  const effectiveUser = useMemo<SessionUser | null>(() => {
    if (!user || !previewRole) return user;
    return { ...user, role: previewRole, permissions: rolePermissions[previewRole] ?? [] };
  }, [user, previewRole, rolePermissions]);

  return (
    <AuthContext.Provider
      value={{ user: effectiveUser, realUser: user, previewRole, loading, login: client.login, signup: client.signup, logout: client.logout, impersonatedBy: user?.impersonatedBy ?? null, startImpersonation: client.startImpersonation, stopImpersonation: client.stopImpersonation }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
