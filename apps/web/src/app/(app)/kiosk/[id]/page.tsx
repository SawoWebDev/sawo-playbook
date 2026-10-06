'use client';

import { Loading } from '@/components/feedback/Loading';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Lightbox } from '@/components/Lightbox';
import { SubbarLeft } from '@/components/Subbar';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/format';
import type { SopDetail, VersionDetail } from '@/lib/types';

const clock = (t: number) => {
  const n = Math.max(0, Math.round(t));
  return [Math.floor(n / 3600), Math.floor((n % 3600) / 60), n % 60].map((x) => String(x).padStart(2, '0')).join(':');
};

/**
 * Kiosk mode (Phase 2): one step at a time, for shop-floor screens.
 * Always shows the CURRENT published version; re-checks every few
 * minutes so a newly published version appears without manual reload.
 */
export default function KioskPage() {
  const { id } = useParams<{ id: string }>();
  const [sop, setSop] = useState<SopDetail | null>(null);
  const [v, setV] = useState<VersionDetail | null>(null);
  const [idx, setIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);

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
    void load();
    const t = setInterval(load, 5 * 60_000);
    return () => clearInterval(t);
  }, [load]);

  const total = v?.steps.length ?? 0;
  const go = useCallback((d: number) => setIdx((i) => Math.max(0, Math.min(total - 1, i + d))), [total]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest('input, select, textarea')) return;
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') go(1);
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(-1);
      if (e.key === 'Home') setIdx(0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  const step = v?.steps[idx];

  if (error && !sop) return <div className="error">{error}</div>;
  if (!sop || !v) return <Loading />;

  const images = step && !step.isTextOnly ? step.media.filter((m) => m.type === 'image') : [];

  return (
    <>
      <SubbarLeft>
        <Link href={`/sops/${id}`} className="back-btn">
          <i className="fa-solid fa-chevron-left" aria-hidden /> Back
        </Link>
        <strong className="bar-title">{sop.name}</strong>
      </SubbarLeft>

      {zoom !== null && <Lightbox images={images.map((m) => ({ url: m.url, alt: m.originalFilename }))} start={zoom} onClose={() => setZoom(null)} />}
      <div className="kiosk">
        <div className="kiosk-card">
          {error && <div className="error" style={{ padding: '0 20px' }}>{error}</div>}
          {step ? (
            <div className="kiosk-body">
              <div className="kiosk-steplabel">
                STEP {step.order}
                {step.isCritical && <span className="kiosk-critical">CRITICAL</span>}
              </div>
              {step.title && <div className="kiosk-steptitle">{step.title}</div>}
              {images.length > 0 && (
                <div className="kiosk-media">
                  {images.map((m, i) => (
                    <figure key={m.id}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={m.url} alt={m.originalFilename} className="zoomable" title="Click to enlarge" onClick={() => setZoom(i)} />
                      {step.usesOkNotokMedia && (
                        <figcaption className={`badge ${i === 0 ? 'badge-green' : 'badge-red'}`}>{i === 0 ? 'OK' : 'NOT OK'}</figcaption>
                      )}
                    </figure>
                  ))}
                </div>
              )}
              {Math.round(step.plannedTimeSeconds) > 0 && (
                <div className="kiosk-planned">
                  <span>Planned Time:</span>
                  <strong>{clock(step.plannedTimeSeconds)}</strong>
                </div>
              )}
              <div className="kiosk-desclabel">Description</div>
              <div className="rich kiosk-text" dangerouslySetInnerHTML={{ __html: step.description }} />
            </div>
          ) : (
            <div className="kiosk-body muted">No steps.</div>
          )}

          <footer className="kiosk-foot">
            <button className="kiosk-prev" disabled={idx === 0} onClick={() => go(-1)}>
              Previous
            </button>
            <div className="kiosk-pager">
              <span>STEP</span>
              <select value={idx} onChange={(e) => setIdx(Number(e.target.value))} aria-label="Go to step">
                {v.steps.map((s, i) => (
                  <option key={s.id} value={i}>
                    {i + 1}
                  </option>
                ))}
              </select>
              <span>OF</span>
              <b>{total}</b>
            </div>
            <button className="kiosk-next" disabled={idx >= total - 1} onClick={() => go(1)}>
              Next
            </button>
          </footer>
        </div>
      </div>
    </>
  );
}
