'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { StepsView } from '@/components/StepsView';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, fmtDate, fmtDuration } from '@/lib/format';
import type { VersionDetail } from '@/lib/types';

interface QrResolution {
  sopId: string;
  requiresAuth: boolean;
  hasPublishedVersion: boolean;
  sop?: { name: string; referenceNo: string };
  version?: VersionDetail;
}

/**
 * Landing page for a printed QR code (§5). Scanning never grants access by
 * itself: without public viewing the visitor must sign in, and edit intent
 * always goes through the authenticated SOP page.
 */
export default function QrLandingPage() {
  return (
    <Suspense fallback={<div className="auth-wrap muted">Opening…</div>}>
      <QrLanding />
    </Suspense>
  );
}

function QrLanding() {
  const { token } = useParams<{ token: string }>();
  const intent = useSearchParams().get('intent');
  const router = useRouter();
  const { user, loading } = useAuth();
  const [data, setData] = useState<QrResolution | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<QrResolution>(`/qr/${encodeURIComponent(token)}`)
      .then(setData)
      .catch((e) => setError(e?.status === 404 ? 'This QR code is not valid.' : errorMessage(e)));
  }, [token]);

  useEffect(() => {
    if (!data || loading) return;
    const target = intent === 'edit' ? `/sops/${data.sopId}?edit=1` : `/sops/${data.sopId}`;
    if (user) router.replace(target);
    else if (data.requiresAuth || intent === 'edit') router.replace(`/login?next=${encodeURIComponent(`/s/${token}${intent ? `?intent=${intent}` : ''}`)}`);
  }, [data, user, loading, intent, router, token]);

  if (error) return <div className="auth-wrap error">{error}</div>;
  if (!data || loading || user || data.requiresAuth || intent === 'edit') return <div className="auth-wrap muted">Opening…</div>;
  if (!data.version || !data.sop) return <div className="auth-wrap muted">This procedure has not been published yet.</div>;

  const v = data.version;
  return (
    <div className="main" style={{ margin: '0 auto' }}>
      <div className="muted" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
        {data.sop.referenceNo}
      </div>
      <h1>{data.sop.name}</h1>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="badge badge-green">Version {v.label}</span>
        <span className="badge">Cycle time {fmtDuration(v.cycleTimeSeconds)}</span>
        <span className="muted">Published {fmtDate(v.publishedAt)}</span>
        <div className="spacer" />
        <a className="btn btn-sm" href={`/login?next=${encodeURIComponent(`/s/${token}`)}`}>
          Sign in
        </a>
      </div>
      <StepsView steps={v.steps} />
    </div>
  );
}
