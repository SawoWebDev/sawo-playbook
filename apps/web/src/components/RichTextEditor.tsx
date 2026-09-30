'use client';

import { useEffect, useRef } from 'react';

/**
 * Minimal rich-text editor (bold / italic / underline / lists). Output is
 * sanitised server-side (§7.8), so this component never has to be trusted.
 */
export function RichTextEditor({ value, onChange, placeholder }: { value: string; onChange: (html: string) => void; placeholder?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  // Only push external value into the DOM when it differs, so the caret isn't reset while typing.
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== value) ref.current.innerHTML = value;
  }, [value]);

  const cmd = (command: string) => {
    ref.current?.focus();
    document.execCommand(command);
    onChange(ref.current?.innerHTML ?? '');
  };

  return (
    <div>
      <div className="rte-toolbar">
        <button type="button" className="btn btn-sm" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('bold')}>
          <b>B</b>
        </button>
        <button type="button" className="btn btn-sm" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('italic')}>
          <i>I</i>
        </button>
        <button type="button" className="btn btn-sm" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('underline')}>
          <u>U</u>
        </button>
        <button type="button" className="btn btn-sm" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('insertUnorderedList')}>
          • List
        </button>
        <button type="button" className="btn btn-sm" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('insertOrderedList')}>
          1. List
        </button>
      </div>
      <div
        ref={ref}
        className="rte rich"
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={() => onChange(ref.current?.innerHTML ?? '')}
      />
    </div>
  );
}
