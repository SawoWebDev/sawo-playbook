'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { allowed, ROLE_LABELS, type Capability } from '@/lib/permissions';

interface NavItem {
  href: string;
  label: string;
  cap?: Capability;
}

const MODULES: NavItem[] = [
  { href: '/checklists', label: 'Checklists', cap: 'viewSops' },
  { href: '/folders', label: 'Folders', cap: 'viewSops' },
  { href: '/analytics', label: 'Analytics', cap: 'viewAnalytics' },
];

const TABS: NavItem[] = [
  { href: '/sops', label: 'STD OPS', cap: 'viewSops' },
  { href: '/kanbans', label: 'KANBANS', cap: 'viewSops' },
  { href: '/skills', label: 'SKILLS', cap: 'viewSkills' },
];

const ADMIN: NavItem[] = [
  { href: '/users', label: 'Manage Users', cap: 'manageUsers' },
  { href: '/settings', label: 'Organization', cap: 'manageSettings' },
  { href: '/backups', label: 'Backups', cap: 'manageSettings' },
  { href: '/audit', label: 'Audit Log', cap: 'viewAudit' },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [menu, setMenu] = useState(false);
  const [counts, setCounts] = useState<{ sops?: number; kanbans?: number }>({});

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  useEffect(() => {
    setMenu(false);
    if (!user) return;
    api<{ total: number }>('/sops?limit=1').then((r) => setCounts((c) => ({ ...c, sops: r.total }))).catch(() => undefined);
    api<{ total: number }>('/kanbans?limit=1').then((r) => setCounts((c) => ({ ...c, kanbans: r.total }))).catch(() => undefined);
  }, [pathname, user]);

  if (loading || !user) return <div className="auth-wrap muted">Loading…</div>;

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
  const visible = (items: NavItem[]) => items.filter((i) => !i.cap || allowed(user.role, i.cap));
  const tabs = visible(TABS);
  const menuItems = [...visible(MODULES), ...visible(ADMIN), { href: '/profile', label: 'Profile' }];
  // The module toolbar (tabs) is only shown on the three list pages, not on detail pages.
  const showBar = TABS.some((t) => pathname === t.href);
  const detailBar = /^\/(sops|kiosk)\/[^/]+$/.test(pathname) || /^\/kanbans\/([^/]+|[^/]+\/edit)$/.test(pathname);
  const count = (href: string) => (href === '/sops' ? counts.sops : href === '/kanbans' ? counts.kanbans : undefined);

  return (
    <div className="app">
      <header className="topbar">
        <Link href="/sops" className="logo" aria-label="SAWO Playbook home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/images/logo-sawo.webp" alt="SAWO" width={75} height={97} />
          <span className="logo-name">SAWO Playbook</span>
        </Link>
        <div className="spacer" />
        {!showBar && (
          <nav className="topnav">
            {allowed(user.role, 'viewSops') && <Link href="/folders">FOLDERS</Link>}
            {tabs.map((t) => (
              <Link key={t.href} href={t.href}>
                {t.label}
                {count(t.href) !== undefined && ` (${count(t.href)})`}
              </Link>
            ))}
          </nav>
        )}
        <div className="menu">
          <button className="avatar" aria-label="Account menu" title={user.name} aria-expanded={menu} onClick={() => setMenu((o) => !o)}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="10" r="3.2" />
              <path d="M6.2 18.4a6.5 6.5 0 0 1 11.6 0" />
            </svg>
          </button>
          {menu && (
            <div className="menu-list" onMouseLeave={() => setMenu(false)}>
              <div className="menu-user">
                <strong>{user.name}</strong>
                <span className="muted">{ROLE_LABELS[user.role]}</span>
              </div>
              {menuItems.map((i) => (
                <Link key={i.href} href={i.href} className={isActive(i.href) ? 'active' : ''}>
                  {i.label}
                </Link>
              ))}
              <button
                className="danger"
                onClick={async () => {
                  await logout();
                  router.replace('/login');
                }}
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>
      {showBar && (
        <div className="subbar">
          <div className="subbar-side" id="subbar-left">
            <nav className="tabs">
              {tabs.map((t) => (
                <Link key={t.href} href={t.href} className={isActive(t.href) ? 'active' : ''}>
                  {t.label}
                  {count(t.href) !== undefined && ` (${count(t.href)})`}
                </Link>
              ))}
            </nav>
          </div>
          <div className="subbar-side subbar-right" id="subbar-right" />
        </div>
      )}
      {detailBar && (
        <div className="subbar detail-bar">
          <div className="subbar-side" id="subbar-left" />
          <div className="subbar-side subbar-right" id="subbar-right" />
        </div>
      )}
      <main className="main">{children}</main>
    </div>
  );
}
