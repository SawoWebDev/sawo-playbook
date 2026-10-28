'use client';

import { useEffect } from 'react';

/**
 * Stops a click on a dialog's backdrop from closing it once the user has typed or changed something inside it, so a
 * stray click (or a text selection dragged outside the box) cannot throw away a half-filled form. Dialogs still close
 * through their own Cancel / Done buttons. Untouched dialogs keep closing on a backdrop click as before.
 */
export function useDialogGuard() {
  useEffect(() => {
    const dirty = new WeakSet<Element>();
    const backdropOf = (t: EventTarget | null) => (t instanceof Element ? t.closest('.dialog-backdrop') : null);

    const markDirty = (e: Event) => {
      const el = e.target;
      if (el instanceof HTMLInputElement && (el.readOnly || el.type === 'file')) return;
      const backdrop = backdropOf(el);
      if (backdrop) dirty.add(backdrop);
    };

    const guardClick = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof Element && t.classList.contains('dialog-backdrop') && dirty.has(t)) {
        e.stopPropagation();
        t.classList.remove('dialog-shake');
        void (t.firstElementChild as HTMLElement | null)?.offsetWidth;
        t.firstElementChild?.classList.add('dialog-shake');
      }
    };

    // Capture phase on document runs before React's own handlers, so stopPropagation keeps onClose from firing.
    document.addEventListener('input', markDirty, true);
    document.addEventListener('change', markDirty, true);
    document.addEventListener('click', guardClick, true);
    return () => {
      document.removeEventListener('input', markDirty, true);
      document.removeEventListener('change', markDirty, true);
      document.removeEventListener('click', guardClick, true);
    };
  }, []);
}
