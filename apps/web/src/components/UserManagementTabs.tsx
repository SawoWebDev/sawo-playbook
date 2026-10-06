'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Section switcher for the Admin-only User Management area. Visibility is decided by the caller's permissions. */
const SECTIONS = [
  { href: '/users', label: 'Users' },
  { href: '/groups', label: 'Groups' },
  { href: '/roles', label: 'Roles & Permissions' },
];

export function UserManagementTabs() {
  const pathname = usePathname();
  return (
    <nav className="tabs" aria-label="User management sections" style={{ marginBottom: 16 }}>
      {SECTIONS.map((s) => {
        const active = pathname.startsWith(s.href);
        return (
          <Link key={s.href} href={s.href} className={`btn btn-sm ${active ? 'btn-primary' : ''}`} aria-current={active ? 'page' : undefined}>
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
