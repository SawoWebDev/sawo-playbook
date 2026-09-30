'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/format';
import type { SopDetail } from '@/lib/types';

/** Printable QR label sheet for posting at the workstation (Phase 2). */
export default function PrintQrPage() {
  const { id } = useParams<{ id: string }>();
  const { user, loading } = useAuth();
  const [sop, setSop] = useState<SopDetail | null>(null);
  const [copies, setCopies] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user) api<SopDetail>(`/sops/${id}`).then(setSop).catch((e) => setError(errorMessage(e)));
  }, [user, id]);

  if (!loading && !user) return <div className="auth-wrap">Please sign in.</div>;
  if (error) return <div className="auth-wrap error">{error}</div>;
  if (!sop) return <div className="auth-wrap muted">Loading…</div>;

  const link = `${window.location.origin}/s/${sop.qrPublicToken}`;
  return (
    <div style={{ padding: 16 }}>
      <div className="row no-print" style={{ marginBottom: 16 }}>
        <label className="row" style={{ margin: 0 }}>
          Copies
          <input type="number" min={1} max={24} value={copies} onChange={(e) => setCopies(Math.max(1, Math.min(24, Number(e.target.value) || 1)))} style={{ width: 70 }} />
        </label>
        <button className="btn btn-primary" onClick={() => window.print()}>
          Print
        </button>
      </div>
      <div className="qr-sheet">
        {Array.from({ length: copies }, (_, i) => (
          <div key={i} className="qr-label">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/qr/${sop.qrPublicToken}/image.png`} alt="QR" />
            <div>
              <div className="ref">{sop.referenceNo}</div>
              <div className="name">{sop.name}</div>
              <div className="hint">Scan for the current version</div>
              <div className="hint" style={{ wordBreak: 'break-all' }}>{link}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
