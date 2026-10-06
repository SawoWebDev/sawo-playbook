'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { isActionable, loadApprovalItems, type ApprovalItem } from '@/components/approvals/model';
import { applyNavConfig, NAV_CONFIG_EVENT, SECTIONS, type NavConfig, type NavItem } from '@/components/nav-model';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { hasPermission, roleLabel } from '@/lib/permissions';
import { setPreviewRole } from '@/lib/preview-role';

/**
 * App shell, matching the REACT_SITE admin panel (src/Administrator/AdminLayout.jsx).
 * Header: page title and description on the left; global search and the notifications bell on the right.
 * Page toolbars and back links portal into the row at the top of the content (#subbar-left, #subbar-right).
 */

const PROFILE: NavItem = { href: '/profile', label: 'My profile', icon: 'fa-user', description: 'Your account details and sign-in settings.', hidden: true };

const ALL_ITEMS = [...SECTIONS.flatMap((s) => s.items), PROFILE];

const isNavActive = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

/** Link to the page that acts on an approval item, matching the Approval Center. */
const itemHref = (i: ApprovalItem) => (i.kind === 'sop' ? `/approvals/sop/${i.parentId}/${i.id}` : `/approvals/kanban/${i.id}`);

/** Global search: submits to the search page, which already reads the `q` parameter. */
function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (term) router.push(`/search?q=${encodeURIComponent(term)}`);
  };
  return (
    <form className="cms-search" role="search" onSubmit={submit}>
      <i className="fa-solid fa-magnifying-glass cms-search-icon" aria-hidden />
      <input
        className="cms-search-input"
        type="search"
        placeholder="Search SOPs, kanbans, skills…"
        aria-label="Global search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
    </form>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, realUser, previewRole, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [waiting, setWaiting] = useState<ApprovalItem[]>([]);
  const [badgePulse, setBadgePulse] = useState(false);
  // The Admin's saved menu (order + hidden items). Null = the built-in menu. Re-read when settings are saved.
  const [navConfig, setNavConfig] = useState<NavConfig | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = () =>
      api<{ settings: { navConfig: NavConfig | null } | null }>('/organization')
        .then((o) => !cancelled && setNavConfig(o.settings?.navConfig ?? null))
        .catch(() => undefined); // keep the built-in menu if it cannot be read
    void load();
    window.addEventListener(NAV_CONFIG_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(NAV_CONFIG_EVENT, load);
    };
  }, [user]);

  // Pulse the preview badge on each change so the switch is noticed even on another page (as on the REACT_SITE).
  useEffect(() => {
    if (!previewRole) return;
    setBadgePulse(true);
    const t = setTimeout(() => setBadgePulse(false), 5000);
    return () => clearTimeout(t);
  }, [previewRole]);

  // Read the saved collapse state after mount: localStorage is not available during server rendering.
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem('app_sidebar_collapsed') === '1');
    } catch {
      /* storage blocked: keep the expanded sidebar */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('app_sidebar_collapsed', collapsed ? '1' : '0');
    } catch {
      /* storage blocked: the choice simply does not persist */
    }
  }, [collapsed]);

  // Close the mobile drawer and the bell on every route change.
  useEffect(() => {
    setOpen(false);
    setBellOpen(false);
  }, [pathname]);

  // Lock page scroll while the mobile drawer is open.
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  // Approvals waiting on this user, from the Approval Center's own model. The lists are scoped by the server, so a
  // user with no approval access simply sees none.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const refresh = () =>
      loadApprovalItems()
        .then((items) => !cancelled && setWaiting(items.filter(isActionable)))
        .catch(() => !cancelled && setWaiting([]));
    void refresh();
    const timer = setInterval(refresh, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [user, pathname]);

  // Close the bell when clicking outside it. The bell is rendered twice (mobile bar and header), so match by class.
  useEffect(() => {
    if (!bellOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.('.shell-bell')) setBellOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [bellOpen]);

  if (!user || !realUser) return null;

  const visible = (items: NavItem[]) => items.filter((i) => !i.cap || hasPermission(user, i.cap));
  const current = ALL_ITEMS.find((i) => isNavActive(pathname, i.href));
  const initial = (realUser.name || '?').charAt(0).toUpperCase();

  // Leave preview: back to the real role, landing on a page everyone can see.
  const exitPreview = () => {
    setPreviewRole(null);
    router.push('/sops');
  };
  const close = () => setOpen(false);

  const signOut = async () => {
    await logout();
    router.replace('/login');
  };

  const bell = (
    <div className="shell-bell">
      <button type="button" className="shell-bell-btn" aria-label={`Notifications${waiting.length ? `, ${waiting.length} waiting` : ''}`} aria-expanded={bellOpen} onClick={() => setBellOpen((o) => !o)}>
        <i className="fa-solid fa-bell" aria-hidden />
        {waiting.length > 0 && <span className="shell-bell-count">{waiting.length > 99 ? '99+' : waiting.length}</span>}
      </button>
      {bellOpen && (
        <div className="shell-bell-menu" role="dialog" aria-label="Notifications">
          <div className="shell-bell-head">
            <span>Waiting on you</span>
            <Link href="/approvals">View all</Link>
          </div>
          {waiting.length === 0 ? (
            <div className="shell-bell-empty">Nothing needs your action right now.</div>
          ) : (
            <ul className="shell-bell-list">
              {waiting.slice(0, 8).map((i) => (
                <li key={i.key}>
                  <Link href={itemHref(i)}>
                    <div className="shell-bell-title">{i.title}</div>
                    <div className="shell-bell-sub">
                      {i.kind === 'sop' ? 'Standard Op' : 'Kanban'}
                      {i.reference ? ` · ${i.reference}` : ''}
                      {i.submitter ? ` · from ${i.submitter}` : ''}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="admin-shell">
      {/* Mobile top bar: the page title and the bell. */}
      <header className="admin-topbar">
        <button type="button" className="admin-topbar-hamburger" onClick={() => setOpen((o) => !o)} aria-label={open ? 'Close navigation' : 'Open navigation'}>
          <i className={`fa-solid ${open ? 'fa-xmark' : 'fa-bars'}`} aria-hidden />
        </button>
        <span className="admin-topbar-title">{current?.label ?? 'SAWO Playbook'}</span>
        {bell}
      </header>

      <div className={`sidebar-overlay${open ? ' visible' : ''}`} onClick={close} aria-hidden="true" />

      {/* Sidebar */}
      <aside className={`admin-sidebar${open ? ' sidebar-open' : ''}${collapsed ? ' sidebar-collapsed' : ''}`}>
        <button
          type="button"
          className="sidebar-collapse-btn"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <i className={`fa-solid fa-chevron-${collapsed ? 'right' : 'left'}`} aria-hidden />
        </button>

        <Link href="/sops" className="sidebar-brand" onClick={close} aria-label="SAWO Playbook home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/images/logo-sawo.webp" alt="" className="sidebar-brand-logo" />
          <span className="sidebar-brand-full">SAWO Playbook</span>
        </Link>

        <nav className="sidebar-nav">
          {SECTIONS.map((section) => {
            const items = visible(applyNavConfig(section, navConfig));
            if (items.length === 0) return null;
            return (
              <div key={section.key}>
                <div className="sidebar-nav-section-label">{section.label}</div>
                {items.map((item) => (
                  <Link key={item.href} href={item.href} className={isNavActive(pathname, item.href) ? 'active' : ''} onClick={close} title={item.label}>
                    <i className={`fa-solid ${item.icon} nav-icon`} aria-hidden />
                    <span className="sidebar-nav-label">{item.label}</span>
                  </Link>
                ))}
              </div>
            );
          })}
        </nav>

        {/* Footer: identity card with username, role and sign out. The identity block links to My profile. */}
        <div className="sidebar-footer">
          <div className="sidebar-footer-card">
            <Link href={PROFILE.href} className="sidebar-footer-id" onClick={close} title="View your profile">
              <div className="sidebar-footer-avatar">{initial}</div>
              <div className="sidebar-footer-user">
                <div className="sidebar-footer-username">{realUser.name}</div>
                {previewRole ? (
                  // While previewing, the role line is also the way out, as on the REACT_SITE.
                  <button
                    type="button"
                    className={`sidebar-footer-role sidebar-footer-role--preview${badgePulse ? ' is-pulsing' : ''}`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      exitPreview();
                    }}
                    aria-label={`Previewing as ${roleLabel(previewRole)}. Click to exit and return to ${roleLabel(realUser.role)}.`}
                    data-tip={`Previewing as ${roleLabel(previewRole)}. You still have ${roleLabel(realUser.role)} access underneath. Click here to exit.`}
                  >
                    <i className="fa-solid fa-eye" aria-hidden />
                    Exit {roleLabel(previewRole)}
                  </button>
                ) : (
                  <div className="sidebar-footer-role">{roleLabel(user.role)}</div>
                )}
              </div>
            </Link>
            <button type="button" onClick={() => void signOut()} title="Sign out" className="sidebar-footer-btn sidebar-footer-btn--logout">
              <i className="fa-solid fa-right-from-bracket" aria-hidden />
              <span>Logout</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="admin-main">
        <header className="page-header">
          <div className="page-header-title">
            {current && <h1 className="page-title">{current.label}</h1>}
            {current && <p className="page-description">{current.description}</p>}
          </div>
          <div className="page-header-actions">
            <GlobalSearch />
            <div className="page-header-bell">{bell}</div>
          </div>
        </header>
        <div className="admin-main-content">
          {/* Page toolbar: the page's own search, filters and buttons, plus a back link on detail pages. Hidden when empty. */}
          <div className="page-toolbar">
            <div id="subbar-left" />
            <div id="subbar-right" />
          </div>
          <div className="app-content">{children}</div>
        </div>
      </main>
    </div>
  );
}
