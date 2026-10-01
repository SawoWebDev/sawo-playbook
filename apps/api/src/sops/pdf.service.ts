import { Injectable } from '@nestjs/common';
import QRCode from 'qrcode';
import { env } from '../config/env';
import { BRAND, BRAND_FONT_STACK, brandFontCss } from '../pdf/brand';
import { PdfRendererService } from '../pdf/pdf-renderer.service';
import { SAWO_LOGO_DATA_URI } from '../pdf/sawo-logo';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { escapeHtml } from './sanitize';
import { versionLabel } from './sop-status';
import { DEFAULT_CONFIG, SopsService, VersionConfig } from './sops.service';

/**
 * SOP document laid out as printable HTML and rendered to PDF by the in-process headless Chromium.
 */
@Injectable()
export class PdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly sops: SopsService,
    private readonly renderer: PdfRendererService,
  ) {}

  async pdfForVersion(organizationId: string, versionId: string): Promise<Buffer> {
    return this.renderer.htmlToPdf(await this.printableHtml(organizationId, versionId));
  }

  async printableHtml(organizationId: string, versionId: string): Promise<string> {
    const v = await this.sops.loadVersionForRender(organizationId, versionId);
    const sop = await this.prisma.sop.findFirstOrThrow({ where: { id: v.sopId, organizationId } });
    return this.buildHtml(organizationId, sop, v);
  }

  private async dataUri(storageKey: string, mime: string): Promise<string> {
    return `data:${mime};base64,${(await this.storage.get(storageKey)).toString('base64')}`;
  }

  private async buildHtml(
    organizationId: string,
    sop: { name: string; referenceNo: string; qrPublicToken: string; createdById: string },
    v: Awaited<ReturnType<SopsService['loadVersionForRender']>>,
  ): Promise<string> {
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    const author = await this.prisma.user.findUnique({ where: { id: sop.createdById }, select: { name: true } });
    const config: VersionConfig = { ...DEFAULT_CONFIG, ...(v.config as Partial<VersionConfig>) };
    const qr = await QRCode.toDataURL(`${env.publicAppUrl}/s/${sop.qrPublicToken}`, { margin: 0, width: 200 });
    const cycle = v.steps.reduce((sum, x) => sum + x.plannedTimeSeconds, 0);
    const clock = (t: number) =>
      [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60].map((n) => String(n).padStart(2, '0')).join(':');
    const dateStr = (d: Date | null) => (d ? `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCFullYear()).slice(2)}` : '—');
    const watermark = v.lifecycleState === 'PUBLISHED' ? '' : `<div class="watermark">${escapeHtml(v.lifecycleState)}</div>`;

    const perPage = Math.min(12, Math.max(1, config.steps_per_page || 6));
    const rows = Math.ceil(perPage / 3);
    const pages: (typeof v.steps)[] = [];
    for (let i = 0; i < v.steps.length; i += perPage) pages.push(v.steps.slice(i, i + perPage));
    if (pages.length === 0) pages.push([]);

    const card = async (s: (typeof v.steps)[number]): Promise<string> => {
      const imgs: string[] = [];
      if (!s.isTextOnly) {
        for (const m of s.media) {
          if (m.mediaAsset.type === 'image') imgs.push(`<img src="${await this.dataUri(m.mediaAsset.storageKey, m.mediaAsset.mimeType)}" alt="">`);
        }
      }
      const text = s.description.replace(/<[^>]*>/g, '').trim();
      const long = text.length > 110;
      const last = s === v.steps[v.steps.length - 1];
      return `<div class="card">
        <div class="media${imgs.length ? '' : ' empty'}">${imgs.join('')}</div>
        <span class="num">${s.order}</span>
        <span class="time">${clock(s.plannedTimeSeconds)}</span>${last ? `<span class="time total">${clock(cycle)}</span>` : ''}
        <div class="desc${long ? ' small' : ''}">${s.title ? `<b>${escapeHtml(s.title)}</b> ` : ''}${s.description}</div>
      </div>`;
    };

    const label = versionLabel(v.versionSequence);
    const body: string[] = [];
    if (config.cover_sheet) {
      body.push(`<section class="page cover">
        <div class="org">${escapeHtml(org.name)}</div>
        <h1>${escapeHtml(sop.name)}</h1>
        <p>Reference ${escapeHtml(sop.referenceNo)} · Revision ${label}</p>
        <img class="qr-big" src="${qr}" alt="QR">
      </section>`);
    }
    for (let p = 0; p < pages.length; p++) {
      const cards: string[] = [];
      for (const s of pages[p]) cards.push(await card(s));
      body.push(`<section class="page">
        <header>
          <img class="logo" src="${SAWO_LOGO_DATA_URI}" alt="SAWO">
          <h1>${escapeHtml(sop.name)}</h1>
          <div class="scan"><small>Scan To Edit</small><img src="${qr}" alt="QR"></div>
        </header>
        <div class="grid">${cards.join('')}</div>
        <footer>
          <span><b>Revision:</b> ${label} (${dateStr(v.publishedAt)})</span>
          <span><b>Process Ref. No:</b> ${escapeHtml(sop.referenceNo)}</span>
          <span><b>Page ${p + 1} of ${pages.length}</b></span>
          <span><b>Cycle Time:</b> ${clock(cycle)}</span>
          <span><b>Author:</b> ${escapeHtml(author?.name ?? '—')}</span>
        </footer>
      </section>`);
    }

    // Everything interpolated above is either escaped or already-sanitised rich text (§7.8).
    const orient = config.pdf_orientation === 'Portrait' ? 'portrait' : 'landscape';
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(sop.name)}</title>
<style>
  ${brandFontCss()}
  @page { size: A4 ${orient}; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ${BRAND_FONT_STACK}; color: ${BRAND.text}; }
  .page { position: relative; width: ${orient === 'portrait' ? '210mm' : '297mm'}; height: ${orient === 'portrait' ? '297mm' : '210mm'}; padding: 10mm 12mm 8mm; page-break-after: always; display: flex; flex-direction: column; overflow: hidden; }
  header { display: flex; justify-content: center; align-items: center; position: relative; height: 22mm; }
  header h1 { font-size: 16pt; margin: 0 45mm; text-align: center; }
  .scan { position: absolute; right: 0; top: 0; }
  .scan small { display: block; font-size: 7pt; text-align: right; }
  .scan img { width: 14mm; height: 14mm; }
  header .logo { position: absolute; left: 0; top: 50%; transform: translateY(-50%); height: 15mm; width: auto; }
  .grid { flex: 1; min-height: 0; display: grid; grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(${rows}, 1fr); gap: 4mm; margin-top: 2mm; }
  .card { position: relative; background: ${BRAND.tint}; border-radius: 4px; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  .media { flex: 1; min-height: 0; display: flex; justify-content: center; align-items: stretch; gap: 1mm; padding: 2mm 0; }
  .media img { max-width: 100%; min-width: 0; flex: 0 1 auto; object-fit: contain; height: 100%; background: #fff; }
  .num { position: absolute; top: 0; left: 0; width: 9mm; height: 9mm; border-radius: 4px; background: ${BRAND.header}; color: #fff; font-size: 13pt; font-weight: bold; display: flex; align-items: center; justify-content: center; }
  .num.crit { background: ${BRAND.accent}; }
  .time { position: absolute; top: 2.5mm; left: 11mm; background: #111; color: #fff; border-radius: 3px; font-size: 6.5pt; padding: 0 1.5mm; line-height: 4mm; }
  .time.total { left: 30mm; background: ${BRAND.button}; color: #fff; }
  .desc { background: #fff; padding: 1.5mm 0 0; font-size: 11pt; line-height: 1.2; }
  .desc.small { font-size: 8pt; }
  .desc p { margin: 0; }
  footer { display: flex; justify-content: space-between; font-size: 6.5pt; padding-top: 3mm; }
  .cover { align-items: center; justify-content: center; text-align: center; }
  .cover h1 { font-size: 26pt; }
  .qr-big { width: 45mm; height: 45mm; }
  .watermark { position: fixed; top: 40%; left: 25%; font-size: 72pt; color: rgba(180,35,24,.12); transform: rotate(-20deg); z-index: 5; }
</style></head><body>
${watermark}
${body.join('\n')}
<script>window.onload = () => window.print();</script>
</body></html>`;
  }
}
