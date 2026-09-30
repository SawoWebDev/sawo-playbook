import { Injectable } from '@nestjs/common';
import { randomUUID, createHash } from 'crypto';
import QRCode from 'qrcode';
import { env } from '../config/env';
import { markReferenced } from '../media/media-lifecycle';
import { GotenbergService } from '../pdf/gotenberg.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { escapeHtml } from './sanitize';
import { versionLabel } from './sop-status';
import { DEFAULT_CONFIG, SopsService, VersionConfig } from './sops.service';

/**
 * PDF export via Gotenberg (ADR 0001). A PUBLISHED version has exactly one
 * canonical PDF (SOPVersion.pdf_asset_id, Invariant #6) rendered once and
 * reused; unpublished versions are rendered on demand and never stored.
 */
@Injectable()
export class PdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly sops: SopsService,
    private readonly gotenberg: GotenbergService,
  ) {}

  async pdfForVersion(organizationId: string, versionId: string): Promise<{ bytes: Buffer; filename: string }> {
    const v = await this.sops.loadVersionForRender(organizationId, versionId);
    const sop = await this.prisma.sop.findFirstOrThrow({ where: { id: v.sopId, organizationId } });
    const filename = `${sop.referenceNo}-v${versionLabel(v.versionSequence)}.pdf`.replace(/[^\w.\-]+/g, '_');

    if (v.lifecycleState === 'PUBLISHED' && v.pdfAssetId) {
      const asset = await this.prisma.mediaAsset.findUniqueOrThrow({ where: { id: v.pdfAssetId } });
      return { bytes: await this.storage.get(asset.storageKey), filename };
    }

    const bytes = await this.gotenberg.htmlToPdf(await this.buildHtml(organizationId, sop, v));
    if (v.lifecycleState === 'PUBLISHED') await this.storeCanonical(organizationId, v.id, sop.createdById, bytes, filename);
    return { bytes, filename };
  }

  private async storeCanonical(organizationId: string, versionId: string, createdById: string, bytes: Buffer, filename: string) {
    const id = randomUUID();
    const storageKey = `org/${organizationId}/pdf/${versionId}/${id}.pdf`;
    await this.storage.put(storageKey, bytes, 'application/pdf');
    await this.prisma.$transaction(async (tx) => {
      await tx.mediaAsset.create({
        data: {
          id,
          organizationId,
          type: 'pdf',
          storageKey,
          originalFilename: filename,
          mimeType: 'application/pdf',
          sizeBytes: BigInt(bytes.length),
          checksum: createHash('sha256').update(bytes).digest('hex'),
          createdById,
        },
      });
      // Only the first renderer wins; the DB trigger forbids replacing a canonical PDF.
      const claimed = await tx.sopVersion.updateMany({ where: { id: versionId, pdfAssetId: null }, data: { pdfAssetId: id } });
      if (claimed.count === 1) await markReferenced(tx, [id]);
      else await tx.mediaAsset.update({ where: { id }, data: { lifecycleState: 'orphaned', orphanedAt: new Date() } });
    });
  }

  private async dataUri(storageKey: string, mime: string): Promise<string> {
    return `data:${mime};base64,${(await this.storage.get(storageKey)).toString('base64')}`;
  }

  private async buildHtml(
    organizationId: string,
    sop: { name: string; referenceNo: string; qrPublicToken: string },
    v: Awaited<ReturnType<SopsService['loadVersionForRender']>>,
  ): Promise<string> {
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    const config: VersionConfig = { ...DEFAULT_CONFIG, ...(v.config as Partial<VersionConfig>) };
    const qr = await QRCode.toDataURL(`${env.publicAppUrl}/s/${sop.qrPublicToken}`, { margin: 1, width: 180 });
    const cycle = v.steps.reduce((s, x) => s + x.plannedTimeSeconds, 0);
    const status = v.lifecycleState === 'PUBLISHED' ? '' : `<div class="watermark">${escapeHtml(v.lifecycleState)}</div>`;
    const fmtTime = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
    const dateStr = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '—');

    const stepsHtml: string[] = [];
    for (const s of v.steps) {
      const imgs: string[] = [];
      for (const m of s.media) {
        if (m.mediaAsset.type === 'image') imgs.push(`<img src="${await this.dataUri(m.mediaAsset.storageKey, m.mediaAsset.mimeType)}" alt="">`);
      }
      stepsHtml.push(`
        <section class="step ${s.isCritical ? 'critical' : ''}">
          <div class="step-head">
            <span class="num">${s.order}</span>
            <span class="title">${escapeHtml(s.title ?? '')}</span>
            ${s.isCritical ? '<span class="tag">CRITICAL</span>' : ''}
            <span class="time">${fmtTime(s.plannedTimeSeconds)}</span>
          </div>
          <div class="desc">${s.description}</div>
          ${s.linkedSop ? `<div class="link">See SOP: ${escapeHtml(s.linkedSop.referenceNo)} — ${escapeHtml(s.linkedSop.name)}</div>` : ''}
          ${imgs.length ? `<div class="imgs">${imgs.join('')}</div>` : ''}
        </section>`);
    }

    const cover = config.cover_sheet
      ? `<section class="cover">
          <div class="org">${escapeHtml(org.name)}</div>
          <h1>${escapeHtml(sop.name)}</h1>
          <table class="meta">
            <tr><th>Reference</th><td>${escapeHtml(sop.referenceNo)}</td></tr>
            <tr><th>Version</th><td>${versionLabel(v.versionSequence)}</td></tr>
            <tr><th>Published</th><td>${dateStr(v.publishedAt)}</td></tr>
            <tr><th>Steps</th><td>${v.steps.length}</td></tr>
            <tr><th>Cycle time</th><td>${fmtTime(cycle)}</td></tr>
            ${v.changeSummary ? `<tr><th>Changes</th><td>${escapeHtml(v.changeSummary)}</td></tr>` : ''}
          </table>
          <img class="qr-big" src="${qr}" alt="QR">
        </section>`
      : '';

    // Everything interpolated above is either escaped or already-sanitised rich text (§7.8).
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(sop.name)}</title>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11pt; color: #1c2430; }
  header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #1f5fbf; padding-bottom: 6px; margin-bottom: 12px; }
  header h1 { font-size: 16pt; margin: 0; }
  header .sub { color: #5d6878; font-size: 9pt; }
  header img { width: 70px; height: 70px; }
  .cover { page-break-after: always; text-align: center; padding-top: 40mm; }
  .cover .org { color: #5d6878; font-size: 12pt; }
  .cover h1 { font-size: 26pt; margin: 8mm 0; }
  .cover .meta { margin: 0 auto; border-collapse: collapse; text-align: left; }
  .cover .meta th, .cover .meta td { padding: 4px 12px; border-bottom: 1px solid #dde1e7; }
  .qr-big { width: 45mm; height: 45mm; margin-top: 12mm; }
  .step { border: 1px solid #dde1e7; border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; page-break-inside: avoid; }
  .step.critical { border-color: #b42318; border-width: 2px; }
  .step-head { display: flex; gap: 8px; align-items: center; font-weight: bold; }
  .num { background: #1f5fbf; color: #fff; border-radius: 50%; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; font-size: 10pt; }
  .step.critical .num { background: #b42318; }
  .title { flex: 1; }
  .tag { color: #b42318; font-size: 8pt; border: 1px solid #b42318; border-radius: 3px; padding: 0 4px; }
  .time { color: #5d6878; font-weight: normal; font-size: 9pt; }
  .desc { margin-top: 4px; }
  .desc p { margin: 2px 0; }
  .link { font-size: 9pt; color: #1f5fbf; margin-top: 4px; }
  .imgs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .imgs img { max-width: 48%; max-height: 70mm; object-fit: contain; border: 1px solid #eee; }
  .footer { margin-top: 12px; font-size: 9pt; color: #5d6878; }
  .watermark { position: fixed; top: 40%; left: 10%; font-size: 72pt; color: rgba(180,35,24,.12); transform: rotate(-30deg); }
</style></head><body>
${status}
${cover}
<header>
  <div><h1>${escapeHtml(sop.name)}</h1>
  <div class="sub">${escapeHtml(org.name)} · ${escapeHtml(sop.referenceNo)} · Version ${versionLabel(v.versionSequence)} · ${v.lifecycleState === 'PUBLISHED' ? `Published ${dateStr(v.publishedAt)}` : escapeHtml(v.lifecycleState)} · Cycle time ${fmtTime(cycle)}</div></div>
  <img src="${qr}" alt="QR">
</header>
${stepsHtml.join('\n')}
<div class="footer">Uncontrolled when printed. Scan the QR code for the current version.</div>
</body></html>`;
  }
}
