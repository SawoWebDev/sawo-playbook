'use client';

import Link from 'next/link';
import { useAuth } from '@/lib/auth';

const MODULES = [
  { href: '/sops', title: 'STD OPS', text: 'Create, version, approve and publish standard operating procedures.' },
  { href: '/kanbans', title: 'KANBANS', text: 'Parts and components card catalogue with ordering details.' },
  { href: '/skills', title: 'SKILLS', text: 'Skills matrix and training history against specific SOP versions.' },
  { href: '/folders', title: 'FOLDERS', text: 'Organise SOPs into a folder tree.' },
];

export default function HomePage() {
  const { user } = useAuth();
  return (
    <>
      <h1>Welcome, {user?.name}</h1>
      <div className="grid">
        {MODULES.map((m) => (
          <Link key={m.href} href={m.href} className="card" style={{ color: 'inherit' }}>
            <h3 style={{ marginTop: 0 }}>{m.title}</h3>
            <div className="muted">{m.text}</div>
          </Link>
        ))}
      </div>
    </>
  );
}
