import { BRAND_FONT_STACK, brandFontCss } from '../pdf/brand';
import { code128Svg } from '../pdf/code128';
import { SAWO_LOGO_DATA_URI } from '../pdf/sawo-logo';
import { escapeHtml } from '../sops/sanitize';

/**
 * Printable kanban — a faithful copy of the GembaDocs kanban PDF layout (two A4 pages per card):
 *   page 1  "OPTION 1 SMALL": a fold-and-cut strip (front, back, kanban pulled, bin label) + a large bin label
 *   page 2  "OPTION 2 LARGE": the same four parts at quarter-page size, turned sideways
 * Every position below is in millimetres, measured from the reference PDF.
 */

/** Everything one printed kanban needs, already resolved (images as data URIs). */
export interface PrintableKanban {
  partCode: string;
  partDescription: string | null;
  supplier: string | null;
  supplierPartNo: string | null;
  usedFor: string | null;
  orderWhen: string | null;
  orderQty: string | null;
  deliveryTime: string | null;
  location: string | null;
  price: string | null;
  carriage: string | null;
  template: string;
  color: string;
  barcode: string;
  pictureUri: string | null;
  /** QR for the back of the card (ordering URL / email / SOP); null → "no order url" placeholder. */
  qrUri: string | null;
}

const YELLOW = '#ffffe0';
const FRAME = '#d3d3d3';
const RED = '#ff0000';
const ARROW_FILL = '#2297fb';
const ARROW_LINE = '#172c51';
/** The reference uses a condensed face; Montserrat (the SAWO brand font) is wider, so sizes are scaled down. */
const pt = (size: number) => `${Math.round(size * 0.84 * 10) / 10}pt`;

const h = (v: unknown) => escapeHtml(v === null || v === undefined || v === '' ? 'N/A' : String(v));
const at = (x: number, y: number, w: number, hgt: number) => `left:${x}mm;top:${y}mm;width:${w}mm;height:${hgt}mm;`;

const box = (x: number, y: number, w: number, hgt: number, inner = '', extra = '', cls = '') =>
  `<div class="abs ${cls}" style="${at(x, y, w, hgt)}${extra}">${inner}</div>`;

const text = (x: number, y: number, w: number, hgt: number, content: string, style: string, cls = '') =>
  box(x, y, w, hgt, content, style, `txt ${cls}`);

const img = (x: number, y: number, w: number, hgt: number, src: string | null) =>
  src ? box(x, y, w, hgt, `<img src="${src}" alt="">`, '', 'pic') : '';

/** A panel with the grey 1.3 mm frame; `inner` is laid out on the inner area (outer minus frame). */
const panel = (x: number, y: number, w: number, hgt: number, inner: string) =>
  `<div class="panel" style="${at(x, y, w, hgt)}"><div class="inner">${inner}</div></div>`;

/**
 * Content drawn in its own upright coordinates, then turned to fit the panel's inner area (iw × ih):
 * 180 → upside down; -90 → content top on the left (text reads bottom-to-top); 90 → content top on the right.
 */
function turned(rotation: 180 | -90 | 90, iw: number, ih: number, content: string) {
  if (rotation === 180) return `<div class="abs" style="${at(0, 0, iw, ih)}transform:rotate(180deg)">${content}</div>`;
  const style = `${at(0, 0, ih, iw)}transform-origin:0 0;transform:${rotation === -90 ? `translateY(${ih}mm) rotate(-90deg)` : `translateX(${iw}mm) rotate(90deg)`}`;
  return `<div class="abs" style="${style}">${content}</div>`;
}

/** Two-column label/value table filling (x, y, w, hgt); `labelW` is the label column width. */
function table(x: number, y: number, w: number, hgt: number, labelW: number, rows: [string, string | null][], labelPt: number, valuePt: number, rowHeights?: number[]) {
  const total = rowHeights?.reduce((a, b) => a + b, 0) ?? rows.length;
  const trs = rows
    .map(([l, v], i) => {
      const rh = rowHeights ? `${(rowHeights[i] / total) * 100}%` : `${100 / rows.length}%`;
      return `<tr style="height:${rh}"><th style="width:${labelW}mm;font-size:${pt(labelPt)}">${l}</th><td style="font-size:${pt(fit(h(v), w - labelW - 2.6, valuePt, 2, false))}">${h(v)}</td></tr>`;
    })
    .join('');
  return box(x, y, w, hgt, `<table>${trs}</table>`, '', 'tbl');
}

/**
 * Font size (reference pt) that fits `content` on at most `lines` lines of `widthMm` — text is never cut off with
 * "…": it wraps to a second line first and only gets smaller when two lines are still not enough.
 */
function fit(content: string, widthMm: number, size: number, lines = 2, bold = true) {
  const plain = content.replace(/<[^>]*>/g, '').replace(/&[a-z#0-9]+;/gi, 'x');
  const charMm = (s: number) => s * 0.84 * 0.3528 * (bold ? 0.68 : 0.62); // average Montserrat glyph width
  const perLine = (s: number) => Math.max(1, Math.floor(widthMm / charMm(s)));
  let s = size;
  while (s > 4 && Math.ceil(plain.length / perLine(s)) > lines) s -= 0.25;
  return s;
}

const band = (x: number, y: number, w: number, hgt: number, color: string, content: string, size: number) =>
  box(x, y, w, hgt, `<span style="font-size:${pt(fit(content, w - 3, size))}">${content}</span>`, `background:${color};`, 'band');

const qrOrPlaceholder = (x: number, y: number, size: number, k: PrintableKanban) =>
  k.qrUri
    ? box(x, y, size, size, `<img src="${k.qrUri}" alt="QR">`, '', 'pic')
    : box(x, y, size, size, `<span style="font-size:${pt(6.8)}">no order url</span>`, `background:${FRAME};`, 'center');

const barcode = (x: number, y: number, w: number, hgt: number, value: string) => box(x, y, w, hgt, code128Svg(value), '', 'bar');

const logo = (x: number, y: number, hgt: number) => `<img class="abs" src="${SAWO_LOGO_DATA_URI}" alt="SAWO" style="left:${x}mm;top:${y}mm;height:${hgt}mm;width:auto">`;

// ── arrows & cut/fold marks (reference: blue arrows, black scissors / fold icon) ──
const arrowSvg = (dir: 'left' | 'up' | 'down') => {
  const d = { left: 'M10 1 1 8l9 7v-4h13V5H10z', up: 'M8 1 1 9h4v13h6V9h4z', down: 'M8 23 1 15h4V2h6v13h4z' }[dir];
  const vb = dir === 'left' ? '0 0 24 16' : '0 0 16 24';
  return `<svg viewBox="${vb}" preserveAspectRatio="none"><path d="${d}" fill="${ARROW_FILL}" stroke="${ARROW_LINE}" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
};
const arrow = (x: number, y: number, w: number, hgt: number, dir: 'left' | 'up' | 'down') => box(x, y, w, hgt, arrowSvg(dir), '', 'icon');
const curvedArrow = (x: number, y: number, size: number) =>
  box(x, y, size, size, `<svg viewBox="0 0 24 24"><path d="M2 3h10a6 6 0 0 1 6 6v6h4l-7 8-7-8h4V9a2 2 0 0 0-2-2H2z" fill="${ARROW_FILL}" stroke="${ARROW_LINE}" stroke-width="1.2" stroke-linejoin="round"/></svg>`, '', 'icon');
/** Scissors whose blades point at the cut line: right (default) for horizontal lines, down for vertical ones. */
const scissors = (x: number, y: number, pointing: 'right' | 'down' = 'right') =>
  box(x, y, 5.3, 5.3, `<svg viewBox="0 0 24 24"${pointing === 'down' ? ' style="transform:rotate(90deg)"' : ''}><circle cx="5" cy="6" r="3.2" fill="none" stroke="#000" stroke-width="2"/><circle cx="5" cy="18" r="3.2" fill="none" stroke="#000" stroke-width="2"/><path d="M7.6 7.8 22 19M7.6 16.2 22 5" stroke="#000" stroke-width="2"/></svg>`, '', 'icon');
/**
 * Fold icon as on the reference card: a square (dashed left edge) with a dashed line across the middle and a
 * fold-back hook on the right. The middle dashed line lies on the fold: as drawn for a horizontal fold (page 1),
 * turned 90° for a vertical one (page 2).
 */
const foldIcon = (x: number, y: number, fold: 'horizontal' | 'vertical' = 'horizontal') =>
  box(
    x,
    y,
    5.3,
    5.3,
    `<svg viewBox="0 0 24 24"${fold === 'vertical' ? ' style="transform:rotate(90deg)"' : ''}>
      <path d="M3 3H17V21H3" fill="#fff" stroke="#000" stroke-width="1.2"/>
      <path d="M3 3V21" stroke="#000" stroke-width="1.2" stroke-dasharray="2 1.6"/>
      <path d="M3 12H17" stroke="#000" stroke-width="1.2" stroke-dasharray="2 1.6"/>
      <path d="M17.6 8.2c3.4.6 3.4 7 0 7.6" fill="none" stroke="#000" stroke-width="1.2"/>
      <path d="M16.6 14.3l1.3 1.6-1.6 1.1" fill="none" stroke="#000" stroke-width="1.2"/>
    </svg>`,
    '',
    'icon',
  );
/** Vertical label reading bottom-to-top (left-hand cut/fold marks). */
const upText = (x: number, y: number, w: number, hgt: number, content: string, size: number) =>
  text(x, y, w, hgt, content, `font-size:${pt(size)};writing-mode:vertical-rl;transform:rotate(180deg);`, 'center');
/** Vertical label reading top-to-bottom (right-hand part labels). */
const downText = (x: number, y: number, w: number, hgt: number, content: string, size: number) =>
  text(x, y, w, hgt, content, `font-size:${pt(size)};writing-mode:vertical-rl;`, 'center');
const dashed = (x: number, y: number, w: number, hgt: number) =>
  box(x, y, w, hgt, '', `${w > hgt ? 'border-top' : 'border-left'}:0.4mm dashed #fff;`);

function detailRows(k: PrintableKanban): [string, string | null][] {
  const rows: [string, string | null][] = [
    ['OUR PART NO.', k.partCode],
    ['SUPPLIER P/NO.', k.supplierPartNo],
    ['USED FOR', k.usedFor],
    ['SUPPLIER', k.supplier],
    ['ORDER WHEN', k.orderWhen],
    ['ORDER QTY', k.orderQty],
    ['DELIVERY TIME', k.deliveryTime],
  ];
  if (k.template === '02') rows.push(['PRICE', k.price], ['CARRIAGE', k.carriage]);
  return rows;
}

/** The description without a leading "[CODE]" (some descriptions already start with the part code). */
const rawDesc = (k: PrintableKanban) => {
  const desc = (k.partDescription ?? '').trim();
  const prefix = `[${k.partCode}]`;
  return (desc.toUpperCase().startsWith(prefix.toUpperCase()) ? desc.slice(prefix.length).trim() : desc).toUpperCase();
};
/** "[CODE] DESCRIPTION" — the part code appears once. */
const rawTitle = (k: PrintableKanban) => `[${k.partCode}]${rawDesc(k) ? ` ${rawDesc(k)}` : ''}`.toUpperCase();
const title = (k: PrintableKanban) => escapeHtml(rawTitle(k));
const desc = (k: PrintableKanban) => escapeHtml(rawDesc(k));
const location = (k: PrintableKanban) => `LOCATION : ${h(k.location)}`;

// ────────────────────────────── page 1 — OPTION 1 SMALL ──────────────────────────────

/** Strip panels: outer 78.6 × 52.4 mm, inner 75.9 × 49.8 mm. */
const SW = 75.9;
const SH = 49.8;

function smallFront(k: PrintableKanban) {
  return [
    band(0, 0, SW, 7.9, k.color, title(k), 8.2),
    img(1.3, 9.3, 28.6, 33.1, k.pictureUri),
    box(1.3, 43.4, 27.8, 5.3, `<span style="font-size:${pt(fit(location(k), 25.8, 5.2))}">${location(k)}</span>`, `background:${YELLOW};`, 'cell center bold'),
    table(31.2, 9.3, 43.4, 39.4, 19.8, detailRows(k), 6.8, 6.0),
  ].join('');
}

function smallBack(k: PrintableKanban) {
  return turned(180, SW, SH, [
    box(0, 0, SW, 12.2, '', `background:${k.color};`),
    barcode(2.6, 2.1, 70.9, 7.9, k.barcode),
    qrOrPlaceholder(26.1, 15.3, 23.3, k),
    logo(1.3, SH - 1.3 - 5.8, 5.8),
  ].join(''));
}

function smallPulled(k: PrintableKanban) {
  return turned(180, SW, SH, [
    band(0, 0, SW, 7.9, k.color, title(k), 8.2),
    img(1.3, 9.2, 28.8, 33.1, k.pictureUri),
    box(31.2, 9.2, 43.4, 26.2, `<span style="font-size:${pt(15)};color:${RED}">KANBAN<br>PULLED</span>`, 'background:#fff;', 'cell center'),
    table(31.2, 35.1, 43.4, 12.2, 20.1, [['ORDER QTY', k.orderQty], ['DELIVERY TIME', k.deliveryTime]], 6.8, 6.8),
  ].join(''));
}

function smallBin(k: PrintableKanban) {
  return turned(180, SW, SH, [
    band(0, 0, SW, 7.9, k.color, location(k), 8.2),
    text(1.3, 13.8, 43.6, 11.5, desc(k), `font-size:${pt(fit(desc(k), 42, 9, 3, false))};line-height:1.2;`, 'center wrap'),
    text(1.3, 26.6, 43.6, 8, escapeHtml(k.partCode), `font-size:${pt(15)};`, 'center'),
    barcode(2.1, 37.5, 42, 4.5, k.barcode),
    img(46.0, 9.2, 28.6, 32.8, k.pictureUri),
  ].join(''));
}

/** The large bin label at the bottom of page 1 (outer 162.4 × 54.5 mm). */
function binLabelWide(k: PrintableKanban) {
  return [
    band(0, 0, 159.8, 7.9, k.color, title(k), 12),
    img(1.3, 9.3, 31, 35.4, k.pictureUri),
    table(33.3, 9.3, 125.2, 40.2, 37.8, [['LOCATION', k.location], ['PART DESCRIPTION', rawDesc(k) || null], ['PART NO', k.partCode]], 10.5, 12, [11.3, 17.2, 11.7]),
  ].join('');
}

function videoBlock(videoQr: string | null, x: number, y: number, size: number, labelX: number, labelY: number, labelPt: number) {
  if (!videoQr) return '';
  return text(labelX, labelY, x - labelX - 2, 9, 'VIDEO EXPLAINER', `font-size:${pt(labelPt)};`) + img(x, y, size, size, videoQr);
}

function pageOne(k: PrintableKanban, videoQr: string | null) {
  const strip = [5.0, 56.4, 107.7, 159.0];
  const parts = [smallFront(k), smallBack(k), smallPulled(k), smallBin(k)];
  return `<section class="page">
    ${parts.map((p, i) => panel(22.5, strip[i], 78.6, 52.4, p)).join('')}
    ${dashed(22.8, 56.7, 78.3, 0.1)}${dashed(22.8, 108.0, 78.3, 0.1)}${dashed(22.8, 159.35, 78.3, 0.1)}
    ${foldIcon(16.7, 54.25)}${upText(16.4, 60.0, 4.3, 6.5, 'Fold', 9)}
    ${scissors(16.7, 105.55)}${upText(17.0, 111.6, 4.3, 5, 'Cut', 9)}
    ${scissors(16.7, 156.9)}${upText(17.0, 162.9, 4.3, 5, 'Cut', 9)}

    ${downText(131.8, 25.0, 5, 20.5, 'FRONT OF CARD', 9)}${arrow(128.5, 46.3, 7.4, 5.8, 'left')}
    ${downText(131.8, 78.2, 5, 18.5, 'BACK OF CARD', 9)}${arrow(128.5, 97.6, 7.4, 5.8, 'left')}
    ${downText(131.8, 126.3, 5, 21.6, 'KANBAN PULLED', 9)}${arrow(128.5, 149.0, 7.4, 5.8, 'left')}
    ${downText(131.8, 174.2, 5, 25, 'BIN LABEL OPTIONS', 9)}${arrow(128.5, 200.3, 7.4, 5.8, 'left')}${curvedArrow(139.9, 201.9, 8.5)}
    ${videoBlock(videoQr, 181.8, 60.3, 13.3, 118, 62.8, 18)}

    ${text(153.2, 5.5, 34, 9, 'OPTION 1', `font-size:${pt(18)};`)}
    ${text(153.2, 14.3, 34, 9, '<b>SMALL</b>', `font-size:${pt(18)};`)}
    ${text(170, 4.2, 38, 9, 'PAGE 1', `font-size:${pt(18)};justify-content:flex-end;`)}
    ${text(170, 14.2, 38, 6.5, 'Paper Style:&nbsp;<b>A4</b>', `font-size:${pt(12)};justify-content:flex-end;`)}

    ${panel(22.5, 214.6, 162.4, 54.5, binLabelWide(k))}
  </section>`;
}

// ────────────────────────────── page 2 — OPTION 2 LARGE ──────────────────────────────

/** Quarter-page panels: outer 91.5 × 127.6 mm, inner 88.9 × 125.0 mm; contents drawn 125.0 wide × 88.9 tall. */
const LW = 88.9;
const LH = 125.0;
const CW = LH;

function largeBin(k: PrintableKanban) {
  return turned(-90, LW, LH, [
    band(0, 0, CW, 17, k.color, location(k), 12),
    text(3.0, 27.3, 58.7, 34, desc(k), `font-size:${pt(fit(desc(k), 56, 18, 4))};font-weight:700;line-height:1.12;`, 'center wrap'),
    text(3.0, 61.5, 58.7, 9, escapeHtml(k.partCode), `font-size:${pt(18)};font-weight:700;`, 'center'),
    barcode(3.0, 73.6, 58.7, 6.3, k.barcode),
    img(62.5, 18.3, 60.6, 69.3, k.pictureUri),
  ].join(''));
}

function largeFront(k: PrintableKanban) {
  return turned(-90, LW, LH, [
    band(0, 0, CW, 17, k.color, title(k), 12),
    img(1.4, 18.3, 46.1, 52.6, k.pictureUri),
    box(1.4, 72.3, 45.3, 15.3, `<span style="font-size:${pt(fit(location(k), 43, 9))}">${location(k)}</span>`, `background:${YELLOW};`, 'cell center bold'),
    table(48.5, 18.3, 75.2, 69.3, 33.9, detailRows(k), 9, 9.8),
  ].join(''));
}

function largePulled(k: PrintableKanban) {
  return turned(90, LW, LH, [
    band(0, 0, CW, 17, k.color, title(k), 12),
    img(1.3, 18.2, 48.4, 55.6, k.pictureUri),
    box(50.8, 18.2, 72.7, 49, `<span style="font-size:${pt(27)};color:${RED};line-height:1.1">KANBAN<br>PULLED</span>`, 'background:#fff;', 'cell center'),
    table(50.8, 66.9, 72.7, 20.4, 33.3, [['ORDER QTY', k.orderQty], ['DELIVERY TIME', k.deliveryTime]], 9, 9.8),
  ].join(''));
}

function largeBack(k: PrintableKanban) {
  return turned(90, LW, LH, [
    box(0, 0, CW, 17, '', `background:${k.color};`),
    barcode(27, 3.7, 70.9, 7.9, k.barcode),
    qrOrPlaceholder(50.8, 37.8, 23.3, k),
    logo(1.3, 81.7, 5.8),
  ].join(''));
}

function pageTwo(k: PrintableKanban, videoQr: string | null) {
  return `<section class="page">
    ${text(17.7, 12.0, 16, 5.6, 'BIN LABEL', `font-size:${pt(10.5)};`)}${arrow(35.0, 12.4, 4.7, 5.9, 'down')}
    ${videoBlock(videoQr, 114.3, 8.7, 13.2, 82.5, 11.0, 12)}
    ${text(150, 11.8, 55.6, 6.5, 'OPTION 2&nbsp;<b>LARGE</b>', `font-size:${pt(12)};justify-content:flex-end;`)}

    ${panel(16.6, 27.8, 91.5, 127.6, largeBin(k))}
    ${panel(107.9, 27.8, 91.6, 127.6, largePulled(k))}
    ${panel(16.6, 155.1, 91.5, 127.5, largeFront(k))}
    ${panel(107.9, 155.1, 91.6, 127.5, largeBack(k))}
    ${dashed(107.8, 157.2, 0.1, 124.9)}${dashed(107.8, 29.5, 0.1, 124.9)}${dashed(18.6, 155.05, 179, 0.1)}

    ${text(97.5, 22.6, 7.4, 4.6, 'Cut', `font-size:${pt(9)};justify-content:flex-end;`)}${scissors(105.35, 22.4, 'down')}
    ${upText(11.2, 146.8, 4.3, 5, 'Cut', 9)}${scissors(11.0, 152.6)}
    ${upText(11.2, 274.1, 4.3, 5, 'Cut', 9)}${scissors(11.0, 280.0)}
    ${foldIcon(105.35, 283.2, 'vertical')}${text(111.6, 283.2, 10, 4.8, 'Fold', `font-size:${pt(9)};`)}

    ${text(39, 285.0, 16, 5.4, 'FRONT', `font-size:${pt(10.5)};justify-content:flex-end;`)}${arrow(56.4, 285.2, 4.7, 5.9, 'up')}
    ${text(123, 285.0, 16, 5.4, 'BACK', `font-size:${pt(10.5)};justify-content:flex-end;`)}${arrow(140.5, 285.2, 4.7, 5.9, 'up')}
    ${text(170, 285.6, 38, 9, 'PAGE 2', `font-size:${pt(18)};justify-content:flex-end;`)}
  </section>`;
}

/** Two A4 pages per kanban. `videoQr`: optional "VIDEO EXPLAINER" QR (data URI). */
export function kanbanPrintHtml(cards: PrintableKanban[], videoQr: string | null = null): string {
  const body = cards.map((k) => pageOne(k, videoQr) + pageTwo(k, videoQr)).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Kanban cards</title><style>
  ${brandFontCss()}
  @page { size: A4 portrait; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ${BRAND_FONT_STACK}; color: #000; }
  .page { position: relative; width: 210mm; height: 297mm; overflow: hidden; page-break-after: always; background: #fff; }
  .abs { position: absolute; }
  .panel { position: absolute; background: #fff; border: 1.3mm solid ${FRAME}; }
  .inner { position: absolute; inset: 0; overflow: hidden; }
  .txt { display: flex; align-items: center; white-space: nowrap; line-height: 1.15; }
  .txt b { font-weight: 700; }
  .center { display: flex; align-items: center; justify-content: center; text-align: center; }
  .wrap { white-space: normal; overflow: hidden; }
  .bold { font-weight: 700; }
  .band { display: flex; align-items: center; justify-content: center; padding: 0 1.5mm; overflow: hidden; }
  .band span { font-weight: 700; white-space: normal; text-align: center; line-height: 1.08; max-width: 100%; overflow-wrap: anywhere; }
  .pic { display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .pic img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
  .cell { border: 0.26mm solid #000; overflow: hidden; }
  .cell span { white-space: normal; text-align: center; line-height: 1.1; max-width: 100%; padding: 0 1mm; overflow-wrap: anywhere; }
  .tbl table { width: 100%; height: 100%; border-collapse: collapse; table-layout: fixed; background: ${YELLOW}; }
  .tbl th, .tbl td { border: 0.26mm solid #000; padding: 0 1.2mm; text-align: left; white-space: nowrap; overflow: hidden; }
  .tbl th { font-weight: 700; }
  .tbl td { font-weight: 400; white-space: normal; line-height: 1.15; overflow-wrap: anywhere; }
  .bar { padding: 0; } .bar svg { display: block; width: 100%; height: 100%; }
  .icon svg { display: block; width: 100%; height: 100%; }
</style></head><body>${body}<script>window.onload = () => window.print();</script></body></html>`;
}
