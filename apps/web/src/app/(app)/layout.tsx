'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { allowed, ROLE_LABELS, type Capability } from '@/lib/permissions';

interface NavItem {
  href: string;
  label: string;
  cap?: Capability;
}

const MODULES: NavItem[] = [
  { href: '/', label: 'Home' },
  { href: '/sops', label: 'STD OPS', cap: 'viewSops' },
  { href: '/checklists', label: 'Checklists', cap: 'viewSops' },
  { href: '/kanbans', label: 'KANBANS', cap: 'viewSops' },
  { href: '/skills', label: 'SKILLS', cap: 'viewSkills' },
  { href: '/folders', label: 'FOLDERS', cap: 'viewSops' },
  { href: '/analytics', label: 'Analytics', cap: 'viewAnalytics' },
];

const ADMIN: NavItem[] = [
  { href: '/users', label: 'Manage Users', cap: 'manageUsers' },
  { href: '/settings', label: 'Organization', cap: 'manageSettings' },
  { href: '/audit', label: 'Audit Log', cap: 'viewAudit' },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  if (loading || !user) return <div className="auth-wrap muted">Loading…</div>;

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
  const visible = (items: NavItem[]) => items.filter((i) => !i.cap || allowed(user.role, i.cap));
  const adminItems = visible(ADMIN);

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">GembaDocs</div>
        {visible(MODULES).map((i) => (
          <Link key={i.href} href={i.href} className={isActive(i.href) ? 'active' : ''}>
            {i.label}
          </Link>
        ))}
        {adminItems.length > 0 && <div className="section">Administration</div>}
        {adminItems.map((i) => (
          <Link key={i.href} href={i.href} className={isActive(i.href) ? 'active' : ''}>
            {i.label}
          </Link>
        ))}
      </nav>
      <div>
        <header className="topbar">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (query.trim()) router.push(`/search?q=${encodeURIComponent(query.trim())}`);
            }}
            style={{ flex: 1, maxWidth: 420 }}
          >
            <input type="search" placeholder="Search SOPs and kanbans…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </form>
          <div className="spacer" />
          <Link href="/profile" className="muted">
            {user.name} · {ROLE_LABELS[user.role]}
          </Link>
          <button
            className="btn btn-sm"
            onClick={async () => {
              await logout();
              router.replace('/login');
            }}
          >
            Sign out
          </button>
        </header>
        <main className="main">{children}</main>
      </div>
    </div>
  );
}
