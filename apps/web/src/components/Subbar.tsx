'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Renders children into the left/right slot of the module toolbar owned by the app layout. */
function Slot({ id, children }: { id: string; children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => setEl(document.getElementById(id)), [id]);
  return el ? createPortal(children, el) : null;
}

export const SubbarLeft = ({ children }: { children: ReactNode }) => <Slot id="subbar-left">{children}</Slot>;
export const SubbarRight = ({ children }: { children: ReactNode }) => <Slot id="subbar-right">{children}</Slot>;

const icon = (d: ReactNode) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
);

export const Icons = {
  folder: icon(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />),
  pencil: icon(<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />),
  filter: icon(<path d="M3 4h18l-7 8v6l-4 2v-8z" />),
  sort: icon(<path d="M7 4v16m0 0-3-3m3 3 3-3M13 6h8M13 11h6M13 16h4" />),
  search: icon(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>,
  ),
};
