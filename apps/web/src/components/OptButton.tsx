import type { ButtonHTMLAttributes } from 'react';

/** The rounded brown button from the "View or Print Options" cards, for use anywhere a styled action button is needed. */
export function OptButton({ outline, inline, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { outline?: boolean; inline?: boolean }) {
  const cls = ['opt-btn', outline && 'outline', inline && 'inline', className].filter(Boolean).join(' ');
  return <button type="button" className={cls} {...rest} />;
}
