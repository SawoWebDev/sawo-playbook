'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { AppShell } from '@/components/AppShell';
import { signedOutOnPurpose } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import '../app-shell.css';

export default function AppLayout({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user) {
      // Come back to this page after signing in, instead of landing on the default page.
      const here = pathname + window.location.search;
      router.replace(!signedOutOnPurpose && here && here !== '/' ? `/login?next=${encodeURIComponent(here)}` : '/login');
    }
    // A temporary password must be replaced before the rest of the app is usable (the server refuses it too).
    if (!loading && user?.passwordMustChange) router.replace('/change-password');
  }, [loading, user, router, pathname]);

  if (loading || !user) return <div className="auth-wrap muted">Loading…</div>;

  return <AppShell>{children}</AppShell>;
}
