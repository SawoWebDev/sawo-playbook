'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Section switcher for the Admin-only User Management area. Visibility is decided by the caller's permissions. */
const SECTIONS = [
  { href: '/users', label: 'Users', icon: 'fa-users' },
  { href: '/groups', label: 'Groups', icon: 'fa-user-group' },
  { href: '/roles', label: 'Roles / Permissions', icon: 'fa-shield-halved' },
];

export function UserManagementTabs() {
  const pathname = usePathname();
  return (
    <nav className="um-tabs" aria-label="User management sections">
      {SECTIONS.map((s) => {
        const active = pathname.startsWith(s.href);
        return (
          <Link key={s.href} href={s.href} className={active ? 'is-active' : ''} aria-current={active ? 'page' : undefined}>
            <i className={`fa-solid ${s.icon}`} aria-hidden /> {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
