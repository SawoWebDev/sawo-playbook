'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export interface LightboxImage {
  url: string;
  alt: string;
}

/** Full-screen image pop-up. Esc / backdrop click closes; ← → (or the side buttons) step through the images. */
export function Lightbox({ images, start, onClose }: { images: LightboxImage[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(start);
  const n = images.length;
  const go = useCallback((d: number) => setI((x) => (x + d + n) % n), [n]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') go(1);
      if (e.key === 'ArrowLeft') go(-1);
    };
    // capture so page-level arrow-key handlers (e.g. step-by-step paging) don't also fire
    const capture = (e: KeyboardEvent) => {
      if (['Escape', 'ArrowRight', 'ArrowLeft'].includes(e.key)) {
        e.stopPropagation();
        onKey(e);
      }
    };
    window.addEventListener('keydown', capture, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', capture, true);
      document.body.style.overflow = overflow;
    };
  }, [go, onClose]);

  const img = images[i];
  if (!img) return null;

  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={img.alt} onClick={onClose}>
      <button type="button" className="lightbox-close" aria-label="Close" onClick={onClose}>
        ✕
      </button>
      {n > 1 && (
        <button
          type="button"
          className="lightbox-nav prev"
          aria-label="Previous image"
          onClick={(e) => {
            e.stopPropagation();
            go(-1);
          }}
        >
          ‹
        </button>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={img.url} alt={img.alt} onClick={(e) => e.stopPropagation()} />
      {n > 1 && (
        <button
          type="button"
          className="lightbox-nav next"
          aria-label="Next image"
          onClick={(e) => {
            e.stopPropagation();
            go(1);
          }}
        >
          ›
        </button>
      )}
      {n > 1 && (
        <div className="lightbox-count">
          {i + 1} / {n}
        </div>
      )}
    </div>,
    document.body,
  );
}
