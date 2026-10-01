'use client';

import { useState } from 'react';
import { Lightbox, type LightboxImage } from '@/components/Lightbox';
import type { Step } from '@/lib/types';

const clock = (t: number) => {
  const s = Math.max(0, Math.round(t));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
};

/** Read-only rendering of a version's steps as a 3-column card grid. Descriptions are server-sanitised HTML (§7.8). */
export function StepsView({ steps, showTitles }: { steps: Step[]; showTitles?: boolean }) {
  const [popup, setPopup] = useState<{ images: LightboxImage[]; start: number } | null>(null);
  if (steps.length === 0) return <p className="muted">This version has no steps yet.</p>;
  return (
    <>
    <ol className="steps steps-grid">
      {steps.map((s) => {
        const hasMedia = !s.isTextOnly && s.media.length > 0;
        const images = s.media.filter((m) => m.type === 'image');
        return (
          <li key={s.id} className={`step-card${s.isCritical ? ' critical' : ''}`}>
            <div className="step-head">
              <span className="step-label-view">Step {s.order}</span>
              {(showTitles || s.title) && s.title && <strong className="step-title">{s.title}</strong>}
            </div>
            <div className="step-time">
              <span className="time-badge">{clock(s.plannedTimeSeconds)}</span>
            </div>
            <div className={`step-media${hasMedia ? '' : ' empty'}`}>
              {hasMedia &&
                s.media.map((m) =>
                  m.type === 'image' ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <a
                      key={m.id}
                      href={m.url}
                      title="Click to enlarge"
                      onClick={(e) => {
                        e.preventDefault();
                        setPopup({ images: images.map((x) => ({ url: x.url, alt: x.originalFilename })), start: images.indexOf(m) });
                      }}
                    >
                      <img src={m.url} alt={m.originalFilename} />
                    </a>
                  ) : (
                    <a key={m.id} href={m.url} target="_blank" rel="noreferrer" className="btn btn-sm">
                      {m.originalFilename}
                    </a>
                  ),
                )}
            </div>
            <div className="step-desc">
              <div className="rich" dangerouslySetInnerHTML={{ __html: s.description }} />
              {s.linkedSop && (
                <div className="muted" style={{ marginTop: 6 }}>
                  See also: <a href={`/sops/${s.linkedSop.id}`}>{s.linkedSop.referenceNo} — {s.linkedSop.name}</a>
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
    {popup && <Lightbox images={popup.images} start={popup.start} onClose={() => setPopup(null)} />}
    </>
  );
}
