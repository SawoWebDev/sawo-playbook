import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ChecklistResult, OrgRole, Prisma } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { MediaService, UploadedFileLike } from '../media/media.service';
import { markReferenced, reevaluateMedia } from '../media/media-lifecycle';
import { PrismaService } from '../prisma/prisma.service';
import { versionLabel } from '../sops/sop-status';
import { DEFAULT_CONFIG, SopsService, VersionConfig } from '../sops/sops.service';

/** Supervisory roles see every submission in the org; everyone else only their own. */
const SUPERVISORS: OrgRole[] = ['OWNER', 'ADMIN', 'EDITOR', 'TRAINER'];

export interface ResponseInput {
  result?: ChecklistResult | null;
  value?: string | null;
  comment?: string | null;
  mediaAssetId?: string | null;
}

@Injectable()
export class ChecklistsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sops: SopsService,
    private readonly media: MediaService,
  ) {}

  /**
   * Invariant #21: the submission is pinned to the exact PUBLISHED version
   * current at start time; later publishes never change it.
   */
  async start(actor: AuthUser, sopId: string) {
    const sop = await this.sops.findSop(actor, sopId);
    if (!sop.currentPublishedVersionId || sop.archivedAt) throw new BadRequestException('SOP has no published version');
    const version = await this.prisma.sopVersion.findFirstOrThrow({
      where: { id: sop.currentPublishedVersionId, organizationId: actor.organizationId, lifecycleState: 'PUBLISHED' },
    });
    const config: VersionConfig = { ...DEFAULT_CONFIG, ...(version.config as Partial<VersionConfig>) };
    if (!config.checklist_sop) throw new BadRequestException('This SOP is not configured as a checklist');
    const sub = await this.prisma.checklistSubmission.create({
      data: { organizationId: actor.organizationId, sopVersionId: version.id, operatorId: actor.id },
    });
    return this.get(actor, sub.id);
  }

  async list(actor: AuthUser, q: { sopId?: string; status?: string }) {
    const where: Prisma.ChecklistSubmissionWhereInput = { organizationId: actor.organizationId };
    if (!SUPERVISORS.includes(actor.role)) where.operatorId = actor.id;
    if (q.status && ['in_progress', 'completed', 'abandoned'].includes(q.status)) where.status = q.status as Prisma.EnumChecklistStatusFilter['equals'];
    if (q.sopId) where.sopVersion = { sopId: q.sopId };
    const rows = await this.prisma.checklistSubmission.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: 200,
      include: {
        sopVersion: { select: { id: true, versionSequence: true, sop: { select: { id: true, name: true, referenceNo: true } }, _count: { select: { steps: true } } } },
        _count: { select: { responses: true } },
        responses: { where: { result: 'not_ok' }, select: { id: true } },
      },
    });
    const ops = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.operatorId))] }, organizationId: actor.organizationId },
      select: { id: true, name: true },
    });
    const byId = new Map(ops.map((o) => [o.id, o]));
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      operator: byId.get(r.operatorId) ?? null,
      sop: r.sopVersion.sop,
      version: { id: r.sopVersion.id, label: versionLabel(r.sopVersion.versionSequence) },
      answered: r._count.responses,
      totalSteps: r.sopVersion._count.steps,
      notOk: r.responses.length,
    }));
  }

  private async find(actor: AuthUser, id: string) {
    const sub = await this.prisma.checklistSubmission.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!sub || (!SUPERVISORS.includes(actor.role) && sub.operatorId !== actor.id)) throw new NotFoundException('Checklist not found');
    return sub;
  }

  private async findOwnInProgress(actor: AuthUser, id: string) {
    const sub = await this.find(actor, id);
    if (sub.operatorId !== actor.id) throw new ForbiddenException('Only the operator who started this checklist can fill it in');
    if (sub.status !== 'in_progress') throw new ConflictException(`Checklist is ${sub.status}`);
    return sub;
  }

  async get(actor: AuthUser, id: string) {
    const sub = await this.find(actor, id);
    const [v, responses, operator] = await Promise.all([
      this.sops.loadVersionForRender(actor.organizationId, sub.sopVersionId),
      this.prisma.checklistResponse.findMany({ where: { submissionId: id }, include: { mediaAsset: true } }),
      this.prisma.user.findFirst({ where: { id: sub.operatorId, organizationId: actor.organizationId }, select: { id: true, name: true } }),
    ]);
    const sop = await this.prisma.sop.findFirstOrThrow({ where: { id: v.sopId, organizationId: actor.organizationId }, select: { id: true, name: true, referenceNo: true } });
    return {
      id: sub.id,
      status: sub.status,
      startedAt: sub.startedAt,
      completedAt: sub.completedAt,
      operator,
      sop,
      version: await this.sops.versionView(v),
      responses: await Promise.all(
        responses.map(async (r) => ({
          stepId: r.stepId,
          result: r.result,
          value: r.value,
          comment: r.comment,
          recordedAt: r.recordedAt,
          media: r.mediaAsset ? await this.media.view(r.mediaAsset) : null,
        })),
      ),
    };
  }

  async respond(actor: AuthUser, id: string, stepId: string, input: ResponseInput) {
    const sub = await this.findOwnInProgress(actor, id);
    const step = await this.prisma.sopStep.findFirst({ where: { id: stepId, sopVersionId: sub.sopVersionId, organizationId: actor.organizationId } });
    if (!step) throw new BadRequestException('Step does not belong to this checklist’s SOP version');
    if (input.mediaAssetId) await this.media.assertUsable(actor.organizationId, [input.mediaAssetId]);

    await this.prisma.$transaction(async (tx) => {
      const previous = await tx.checklistResponse.findUnique({
        where: { submissionId_stepId: { submissionId: id, stepId } },
        select: { mediaAssetId: true },
      });
      const data = {
        result: input.result ?? null,
        value: input.value ?? null,
        comment: input.comment?.trim() || null,
        mediaAssetId: input.mediaAssetId ?? null,
        recordedAt: new Date(),
      };
      await tx.checklistResponse.upsert({
        where: { submissionId_stepId: { submissionId: id, stepId } },
        create: { submissionId: id, stepId, ...data },
        update: data,
      });
      // Execution evidence is durable history — keep it referenced.
      if (input.mediaAssetId) await markReferenced(tx, [input.mediaAssetId]);
      if (previous?.mediaAssetId && previous.mediaAssetId !== input.mediaAssetId) await reevaluateMedia(tx, [previous.mediaAssetId]);
    });
    return this.get(actor, id);
  }

  async uploadEvidence(actor: AuthUser, id: string, file: UploadedFileLike) {
    await this.findOwnInProgress(actor, id);
    return this.media.upload(actor, file);
  }

  async complete(actor: AuthUser, id: string) {
    const sub = await this.findOwnInProgress(actor, id);
    const steps = await this.prisma.sopStep.findMany({ where: { sopVersionId: sub.sopVersionId }, select: { id: true, order: true } });
    const answered = await this.prisma.checklistResponse.findMany({
      where: { submissionId: id, result: { not: null } },
      select: { stepId: true },
    });
    const done = new Set(answered.map((a) => a.stepId));
    const missing = steps.filter((s) => !done.has(s.id)).map((s) => s.order);
    if (missing.length) throw new BadRequestException(`Steps not answered: ${missing.sort((x, y) => x - y).join(', ')}`);
    const claimed = await this.prisma.checklistSubmission.updateMany({
      where: { id, status: 'in_progress' },
      data: { status: 'completed', completedAt: new Date() },
    });
    if (claimed.count !== 1) throw new ConflictException('Checklist is no longer in progress');
    return this.get(actor, id);
  }

  async abandon(actor: AuthUser, id: string) {
    await this.findOwnInProgress(actor, id);
    await this.prisma.checklistSubmission.update({ where: { id }, data: { status: 'abandoned', completedAt: new Date() } });
    return this.get(actor, id);
  }
}
