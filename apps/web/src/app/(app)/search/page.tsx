'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { SopStatusBadge } from '@/components/StatusBadge';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/format';
import type { SopStatus } from '@/lib/types';

interface Results {
  sops: { id: string; name: string; referenceNo: string; status: SopStatus; publishedVersionLabel: string | null; matchedIn: string[] }[];
  kanbans: { id: string; partCode: string; partDescription: string | null; supplier: string | null }[];
}

export default function SearchPage() {
  return (
    <Suspense fallback={<p className="muted">Searching…</p>}>
      <SearchResults />
    </Suspense>
  );
}

function SearchResults() {
  const q = useSearchParams().get('q') ?? '';
  const [r, setR] = useState<Results | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!q.trim()) return setR({ sops: [], kanbans: [] });
    setR(null);
    api<Results>(`/search?q=${encodeURIComponent(q)}`)
      .then(setR)
      .catch((e) => setError(errorMessage(e)));
  }, [q]);

  return (
    <>
      <h1>Search results for “{q}”</h1>
      {error && <div className="error">{error}</div>}
      {!r ? (
        <p className="muted">Searching…</p>
      ) : (
        <>
          <h2>SOPs ({r.sops.length})</h2>
          {r.sops.length === 0 && <p className="muted">No procedures match.</p>}
          <div className="panel">
            {r.sops.map((s) => (
              <Link key={s.id} href={`/sops/${s.id}`} className="card sop-card">
                <div className="row">
                  <span className="ref">{s.referenceNo}</span>
                  <strong>{s.name}</strong>
                  <div className="spacer" />
                  <SopStatusBadge status={s.status} />
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  Matched in: {s.matchedIn.join(', ')}
                  {s.publishedVersionLabel ? ` · current version v${s.publishedVersionLabel}` : ''}
                </div>
              </Link>
            ))}
          </div>
          <h2>Kanbans ({r.kanbans.length})</h2>
          {r.kanbans.length === 0 && <p className="muted">No kanban cards match.</p>}
          <table className="table">
            <tbody>
              {r.kanbans.map((k) => (
                <tr key={k.id}>
                  <td>
                    <Link href={`/kanbans?search=${encodeURIComponent(k.partCode)}`}>
                      <code>{k.partCode}</code>
                    </Link>
                  </td>
                  <td>{k.partDescription}</td>
                  <td className="muted">{k.supplier}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
