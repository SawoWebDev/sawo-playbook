'use client';

import { useEffect, useRef, useState } from 'react';

const TEXT_COLORS = ['#1c2430', '#b42318', '#1f5fbf', '#1a7f37', '#9a6700', '#8250df'];
const HIGHLIGHTS = ['#fff1c7', '#dcf3e2', '#dde9fb', '#fde2df', '#ffffff'];

/** Visible character count of an HTML fragment (what the operator will read). */
export function plainTextLength(html: string): number {
  if (typeof window === 'undefined') return html.replace(/<[^>]*>/g, '').length;
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent ?? '').replace(/ /g, ' ').length;
}

/**
 * Step description editor: bold / italic / underline, text colour, highlight,
 * undo / redo and full-screen. Output is sanitised server-side (§7.8) — only
 * colour and background-colour styles survive.
 */
export function RichTextEditor({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<'color' | 'highlight' | null>(null);
  const [full, setFull] = useState(false);

  // Only push external value into the DOM when it differs, so the caret isn't reset while typing.
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== value) ref.current.innerHTML = value;
  }, [value]);

  const exec = (command: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand('styleWithCSS', false, 'true');
    document.execCommand(command, false, arg);
    onChange(ref.current?.innerHTML ?? '');
    setMenu(null);
  };

  const btn = (label: React.ReactNode, title: string, onClick: () => void) => (
    <button type="button" className="rte-btn" title={title} aria-label={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {label}
    </button>
  );

  return (
    <div className={`rte-wrap${full ? ' rte-full' : ''}`}>
      <div className="rte-toolbar">
        {btn(<b>B</b>, 'Bold', () => exec('bold'))}
        {btn(<i>I</i>, 'Italic', () => exec('italic'))}
        {btn(<u>U</u>, 'Underline', () => exec('underline'))}
        <span className="rte-menu">
          {btn(<span className="rte-a">A ▾</span>, 'Text colour', () => setMenu(menu === 'color' ? null : 'color'))}
          {menu === 'color' && (
            <span className="rte-palette">
              {TEXT_COLORS.map((c) => (
                <button key={c} type="button" style={{ background: c }} aria-label={`Colour ${c}`} onMouseDown={(e) => e.preventDefault()} onClick={() => exec('foreColor', c)} />
              ))}
            </span>
          )}
        </span>
        <span className="rte-menu">
          {btn(<span>🖍 ▾</span>, 'Highlight', () => setMenu(menu === 'highlight' ? null : 'highlight'))}
          {menu === 'highlight' && (
            <span className="rte-palette">
              {HIGHLIGHTS.map((c) => (
                <button key={c} type="button" style={{ background: c }} aria-label={`Highlight ${c}`} onMouseDown={(e) => e.preventDefault()} onClick={() => exec('hiliteColor', c)} />
              ))}
            </span>
          )}
        </span>
        <span className="spacer" />
        {btn('↶', 'Undo', () => exec('undo'))}
        {btn('↷', 'Redo', () => exec('redo'))}
        {btn(full ? '⤡' : '⤢', full ? 'Exit full screen' : 'Full screen', () => setFull((f) => !f))}
      </div>
      <div
        ref={ref}
        className="rte rich"
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel ?? 'Description'}
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={() => onChange(ref.current?.innerHTML ?? '')}
      />
    </div>
  );
}
