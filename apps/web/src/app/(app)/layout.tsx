'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { AppShell } from '@/components/AppShell';
import { useAuth } from '@/lib/auth';
import '../app-shell.css';

export default function AppLayout({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
    // A temporary password must be replaced before the rest of the app is usable (the server refuses it too).
    if (!loading && user?.passwordMustChange) router.replace('/change-password');
  }, [loading, user, router]);

  if (loading || !user) return <div className="auth-wrap muted">Loading…</div>;

  return <AppShell>{children}</AppShell>;
}
