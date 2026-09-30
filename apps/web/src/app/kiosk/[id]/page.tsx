'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, fmtDuration } from '@/lib/format';
import type { SopDetail, VersionDetail } from '@/lib/types';

/**
 * Kiosk mode (Phase 2): full-screen, one step at a time, for shop-floor
 * screens. Always shows the CURRENT published version; re-checks every few
 * minutes so a newly published version appears without manual reload.
 */
export default function KioskPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user, loading } = useAuth();
  const [sop, setSop] = useState<SopDetail | null>(null);
  const [v, setV] = useState<VersionDetail | null>(null);
  const [idx, setIdx] = useState(0);
  const [auto, setAuto] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, cur] = await Promise.all([api<SopDetail>(`/sops/${id}`), api<VersionDetail>(`/sops/${id}/current`)]);
      setSop(s);
      setV((prev) => {
        if (prev && prev.id !== cur.id) setIdx(0);
        return cur;
      });
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id]);

  useEffect(() => {
    if (!loading && !user) router.replace(`/login?next=${encodeURIComponent(`/kiosk/${id}`)}`);
    if (user) void load();
  }, [user, loading, load, router, id]);

  useEffect(() => {
    const t = setInterval(load, 5 * 60_000);
    return () => clearInterval(t);
  }, [load]);

  const total = v?.steps.length ?? 0;
  const go = useCallback((d: number) => setIdx((i) => Math.max(0, Math.min(total - 1, i + d))), [total]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') go(1);
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(-1);
      if (e.key === 'Home') setIdx(0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  const step = v?.steps[idx];
  useEffect(() => {
    if (!auto || !step) return;
    const t = setTimeout(() => (idx < total - 1 ? go(1) : setIdx(0)), Math.max(5, step.plannedTimeSeconds || 10) * 1000);
    return () => clearTimeout(t);
  }, [auto, step, idx, total, go]);

  if (error) return <div className="auth-wrap error">{error}</div>;
  if (!sop || !v) return <div className="auth-wrap muted">Loading…</div>;

  return (
    <div className="kiosk">
      <header className="kiosk-bar">
        <div>
          <div className="muted">
            {sop.referenceNo} · v{v.label}
          </div>
          <strong style={{ fontSize: 20 }}>{sop.name}</strong>
        </div>
        <div className="spacer" />
        <label className="row" style={{ margin: 0, fontWeight: 400 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-advance
        </label>
        <button className="btn btn-sm" onClick={() => document.documentElement.requestFullscreen?.()}>
          Full screen
        </button>
        <button className="btn btn-sm" onClick={() => router.push(`/sops/${id}`)}>
          Exit
        </button>
      </header>

      {step ? (
        <main className={`kiosk-step${step.isCritical ? ' critical' : ''}`}>
          <div className="row" style={{ marginBottom: 16 }}>
            <span className="kiosk-num">{step.order}</span>
            <span style={{ fontSize: 26, fontWeight: 700, flex: 1 }}>{step.title}</span>
            {step.isCritical && <span className="badge badge-red" style={{ fontSize: 16 }}>CRITICAL</span>}
            <span className="badge" style={{ fontSize: 16 }}>
              {fmtDuration(step.plannedTimeSeconds)}
            </span>
          </div>
          <div className="rich kiosk-text" dangerouslySetInnerHTML={{ __html: step.description }} />
          {!step.isTextOnly && (
            <div className="kiosk-media">
              {step.media
                .filter((m) => m.type === 'image')
                .map((m, i) => (
                  <figure key={m.id}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={m.url} alt={m.originalFilename} />
                    {step.usesOkNotokMedia && (
                      <figcaption className={`badge ${i === 0 ? 'badge-green' : 'badge-red'}`}>{i === 0 ? 'OK' : 'NOT OK'}</figcaption>
                    )}
                  </figure>
                ))}
            </div>
          )}
        </main>
      ) : (
        <main className="kiosk-step muted">No steps.</main>
      )}

      <footer className="kiosk-bar">
        <button className="btn" disabled={idx === 0} onClick={() => go(-1)}>
          ← Previous
        </button>
        <div className="spacer" style={{ textAlign: 'center' }}>
          Step {idx + 1} of {total} · Cycle time {fmtDuration(v.cycleTimeSeconds)}
        </div>
        <button className="btn btn-primary" disabled={idx >= total - 1} onClick={() => go(1)}>
          Next →
        </button>
      </footer>
    </div>
  );
}
