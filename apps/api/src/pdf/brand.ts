import { readFileSync } from 'fs';

/**
 * SAWO brand styling shared by every server-rendered HTML document (SOP PDF/print view,
 * kanban cards). The Montserrat font is embedded as a data URI so the renderer and the
 * browser print view need no network access (CSP: font-src 'self' data:).
 */
export const BRAND = {
  header: '#a97d53', // tan top bar / headers
  button: '#b0825e', // caramel buttons / bands
  wood: '#7a4a2c', // dark wood brown text accents
  accent: '#c8454a', // medium red, used sparingly (step labels)
  tint: '#f2f2f2', // light neutral panels
  text: '#1a1a1a',
};

let fontFace: string | undefined;

export function brandFontCss(): string {
  if (fontFace !== undefined) return fontFace;
  try {
    const file = require.resolve('@fontsource-variable/montserrat/files/montserrat-latin-wght-normal.woff2');
    const b64 = readFileSync(file).toString('base64');
    fontFace = `@font-face { font-family: 'Montserrat'; font-style: normal; font-weight: 100 900; font-display: block; src: url(data:font/woff2;base64,${b64}) format('woff2'); }`;
  } catch {
    fontFace = ''; // fall back to the system sans-serif stack below
  }
  return fontFace;
}

export const BRAND_FONT_STACK = "Montserrat, Arial, Helvetica, sans-serif";
