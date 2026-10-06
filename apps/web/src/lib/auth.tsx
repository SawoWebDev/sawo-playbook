'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import * as client from './api';
import type { SessionUser } from './api';

interface AuthState {
  user: SessionUser | null;
  loading: boolean;
  login: typeof client.login;
  signup: typeof client.signup;
  logout: typeof client.logout;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

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
    // Restore the session from the HttpOnly refresh cookie on page load.
    client.refreshSession().finally(() => setLoading(false));
    return () => {
      off();
    };
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, loading, login: client.login, signup: client.signup, logout: client.logout }}
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
