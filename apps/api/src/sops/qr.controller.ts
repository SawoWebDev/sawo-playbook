import { Controller, Get, NotFoundException, Param, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import QRCode from 'qrcode';
import { ActivityService } from '../analytics/activity.service';
import { Public } from '../common/decorators';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { SopsService } from './sops.service';

/**
 * §5 QR resolver. A printed QR encodes `${PUBLIC_APP_URL}/s/{sop.qr_public_token}`
 * — the stable SOP, never a version (Invariant #5). Resolution happens at scan
 * time against SOP.current_published_version_id.
 *
 * Scanning NEVER grants authorization (Invariant #9):
 *  - VIEW: content is returned here only when the org enabled
 *    `public_sop_viewing`; otherwise the client must sign in and use the
 *    normal tenant-scoped `/api/sops/:id/current` endpoint.
 *  - EDIT: the client signs in and calls the permission-checked
 *    `POST /api/sops/:id/versions` (copy-on-write draft).
 */
@Controller('qr')
export class QrController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sops: SopsService,
    private readonly activity: ActivityService,
  ) {}

  private async resolve(token: string) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new NotFoundException();
    const sop = await this.prisma.sop.findUnique({
      where: { qrPublicToken: token },
      include: { organization: { select: { status: true, settings: { select: { publicSopViewing: true } } } } },
    });
    if (!sop || sop.deletedAt || sop.organization.status !== 'active') throw new NotFoundException();
    return sop;
  }

  @Public()
  @Get(':token')
  async resolveToken(@Param('token') token: string) {
    const sop = await this.resolve(token);
    const publicView = !!sop.organization.settings?.publicSopViewing;
    const base = { sopId: sop.id, requiresAuth: !publicView, hasPublishedVersion: !!sop.currentPublishedVersionId };
    if (!publicView || !sop.currentPublishedVersionId || sop.archivedAt) return base;
    const v = await this.sops.loadVersionForRender(sop.organizationId, sop.currentPublishedVersionId);
    const view = await this.sops.versionView(v);
    await this.activity.emit({ organizationId: sop.organizationId, eventType: 'sop.viewed', entityType: 'sop', entityId: sop.id, metadata: { via: 'qr_public' } });
    return {
      ...base,
      sop: { name: sop.name, referenceNo: sop.referenceNo },
      version: { ...view, createdBy: null, submittedBy: null, publishedBy: null },
    };
  }

  /** PNG of the QR code for printing/sharing. The token is already public by design. */
  @Public()
  @Get(':token/image.png')
  async image(@Param('token') token: string, @Res({ passthrough: true }) res: Response) {
    const sop = await this.resolve(token);
    const png = await QRCode.toBuffer(`${env.publicAppUrl}/s/${sop.qrPublicToken}`, { margin: 1, width: 512 });
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    return new StreamableFile(png);
  }
}
