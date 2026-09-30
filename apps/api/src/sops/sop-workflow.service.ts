import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ApprovalDecision } from '@prisma/client';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { RequestMeta } from '../common/decorators';
import { Permission, roleHasPermission } from '../common/permissions';
import { QueueService } from '../jobs/queue.service';
import { markReferenced } from '../media/media-lifecycle';
import { isUniqueViolation, PrismaService } from '../prisma/prisma.service';
import { recomputeSopStatus, versionLabel } from './sop-status';
import { SopVersionRepository } from './sop-version.repository';
import { SopsService } from './sops.service';

/**
 * §6.3 approval state machine, enforced server-side (§7.3 rule 5):
 *
 *   DRAFT --submit--> PENDING_APPROVAL --quorum in current round--> APPROVED --publish--> PUBLISHED
 *                           └──reject──> DRAFT (round += 1 on next submit)
 */
@Injectable()
export class SopWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: SopVersionRepository,
    private readonly sops: SopsService,
    private readonly audit: AuditService,
    private readonly queues: QueueService,
  ) {}

  async submit(actor: AuthUser, sopId: string, versionId: string, changeSummary: string | undefined, meta: RequestMeta) {
    await this.sops.findSop(actor, sopId);
    await this.prisma.$transaction(async (tx) => {
      const v = await this.repo.lockDraft(tx, actor.organizationId, sopId, versionId);
      const version = await tx.sopVersion.findUniqueOrThrow({
        where: { id: v.id },
        select: { currentApprovalRound: true, _count: { select: { steps: true } } },
      });
      if (version._count.steps === 0) throw new BadRequestException('Add at least one step before submitting');
      // A version returned to DRAFT by a rejection starts a fresh round on resubmit (Invariant #17).
      const decidedInRound = await tx.sopVersionApproval.count({
        where: { sopVersionId: v.id, approvalRound: version.currentApprovalRound },
      });
      const round = decidedInRound > 0 ? version.currentApprovalRound + 1 : version.currentApprovalRound;
      await tx.sopVersion.update({
        where: { id: v.id },
        data: {
          lifecycleState: 'PENDING_APPROVAL',
          currentApprovalRound: round,
          submittedById: actor.id,
          submittedAt: new Date(),
          changeSummary: changeSummary ?? undefined,
        },
      });
      await recomputeSopStatus(tx, sopId);
      await this.audit.record(
        { action: AuditAction.SopVersionSubmitted, organizationId: actor.organizationId, actorId: actor.id, entityType: 'sop_version', entityId: v.id, metadata: { sopId, round }, ...meta },
        tx,
      );
    });
    return this.sops.getVersion(actor, sopId, versionId);
  }

  async decide(actor: AuthUser, sopId: string, versionId: string, decision: ApprovalDecision, comment: string | undefined, meta: RequestMeta) {
    await this.sops.findSop(actor, sopId);
    // Invariant #20: eligibility is evaluated now, from the DB-fresh role on the principal.
    if (!roleHasPermission(actor.role, Permission.SopApprove)) throw new ForbiddenException('Not an eligible approver');
    if (decision === 'rejected' && !comment?.trim()) throw new BadRequestException('A comment is required when rejecting');

    try {
      await this.prisma.$transaction(async (tx) => {
        const v = await this.repo.lock(tx, actor.organizationId, sopId, versionId);
        if (v.lifecycleState !== 'PENDING_APPROVAL') {
          throw new ConflictException(`Version is ${v.lifecycleState}, not awaiting approval`);
        }
        const version = await tx.sopVersion.findUniqueOrThrow({ where: { id: v.id } });
        const settings = await tx.organizationSettings.findUniqueOrThrow({ where: { organizationId: actor.organizationId } });
        if (version.submittedById === actor.id && !settings.allowSelfApproval) {
          throw new ForbiddenException('You cannot approve or reject a version you submitted');
        }
        await tx.sopVersionApproval.create({
          data: {
            organizationId: actor.organizationId,
            sopVersionId: v.id,
            approvalRound: version.currentApprovalRound,
            approverId: actor.id,
            decision,
            comment: comment?.trim() || null,
          },
        });

        if (decision === 'rejected') {
          await tx.sopVersion.update({ where: { id: v.id }, data: { lifecycleState: 'DRAFT' } });
          await this.audit.record(
            { action: AuditAction.SopVersionRejected, organizationId: actor.organizationId, actorId: actor.id, entityType: 'sop_version', entityId: v.id, metadata: { sopId, round: version.currentApprovalRound, comment: comment ?? null }, ...meta },
            tx,
          );
        } else {
          const [row] = await tx.$queryRaw<{ n: bigint }[]>`
            SELECT COUNT(DISTINCT approver_id) AS n FROM sop_version_approval
            WHERE sop_version_id = ${v.id}::uuid AND decision = 'approved'
              AND approval_round = ${version.currentApprovalRound}`;
          const approvals = Number(row.n);
          const reached = approvals >= settings.approvalQuorum;
          if (reached) {
            await tx.sopVersion.update({ where: { id: v.id }, data: { lifecycleState: 'APPROVED', approvedAt: new Date() } });
          }
          await this.audit.record(
            { action: AuditAction.SopVersionApproved, organizationId: actor.organizationId, actorId: actor.id, entityType: 'sop_version', entityId: v.id, metadata: { sopId, round: version.currentApprovalRound, approvals, quorum: settings.approvalQuorum, quorumReached: reached }, ...meta },
            tx,
          );
        }
        await recomputeSopStatus(tx, sopId);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('You have already recorded a decision in this approval round');
      throw e;
    }
    return this.sops.getVersion(actor, sopId, versionId);
  }

  /** Publish is a distinct action and permission from Approve (§7.2) — Editors can never publish. */
  async publish(actor: AuthUser, sopId: string, versionId: string, meta: RequestMeta) {
    await this.sops.findSop(actor, sopId);
    if (!roleHasPermission(actor.role, Permission.SopPublish)) throw new ForbiddenException();
    await this.prisma.$transaction(async (tx) => {
      const v = await this.repo.lock(tx, actor.organizationId, sopId, versionId);
      if (v.lifecycleState !== 'APPROVED') throw new ConflictException(`Only APPROVED versions can be published (this one is ${v.lifecycleState})`);
      await tx.sopVersion.update({
        where: { id: v.id },
        data: { lifecycleState: 'PUBLISHED', publishedById: actor.id, publishedAt: new Date() },
      });
      await tx.sop.update({ where: { id: sopId }, data: { currentPublishedVersionId: v.id } });
      const media = await tx.sopStepMedia.findMany({ where: { sopStep: { sopVersionId: v.id } }, select: { mediaAssetId: true } });
      await markReferenced(tx, media.map((m) => m.mediaAssetId));
      await recomputeSopStatus(tx, sopId);
      await this.audit.record(
        { action: AuditAction.SopVersionPublished, organizationId: actor.organizationId, actorId: actor.id, entityType: 'sop_version', entityId: v.id, metadata: { sopId }, ...meta },
        tx,
      );
    });
    // Pre-render the one canonical PDF in the background (§9); first request falls back to inline rendering.
    await this.queues.add('pdf', 'render', { organizationId: actor.organizationId, versionId }, { jobId: `pdf-${versionId}` });
    return this.sops.getVersion(actor, sopId, versionId);
  }

  /** Full, immutable decision history across all rounds. */
  async approvals(actor: AuthUser, sopId: string, versionId: string) {
    await this.sops.findSop(actor, sopId);
    const v = await this.prisma.sopVersion.findFirst({ where: { id: versionId, sopId, organizationId: actor.organizationId } });
    if (!v) throw new NotFoundException('Version not found');
    const [rows, settings] = await Promise.all([
      this.prisma.sopVersionApproval.findMany({
        where: { sopVersionId: versionId, organizationId: actor.organizationId },
        orderBy: [{ approvalRound: 'desc' }, { createdAt: 'asc' }],
      }),
      this.prisma.organizationSettings.findUniqueOrThrow({ where: { organizationId: actor.organizationId } }),
    ]);
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.approverId))] } },
      select: { id: true, name: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    const current = rows.filter((r) => r.approvalRound === v.currentApprovalRound);
    return {
      versionId,
      label: versionLabel(v.versionSequence),
      lifecycleState: v.lifecycleState,
      currentApprovalRound: v.currentApprovalRound,
      quorum: settings.approvalQuorum,
      approvedInCurrentRound: new Set(current.filter((r) => r.decision === 'approved').map((r) => r.approverId)).size,
      submittedById: v.submittedById,
      allowSelfApproval: settings.allowSelfApproval,
      decisions: rows.map((r) => ({
        id: r.id,
        round: r.approvalRound,
        decision: r.decision,
        comment: r.comment,
        createdAt: r.createdAt,
        approver: byId.get(r.approverId) ?? { id: r.approverId, name: 'Unknown user' },
      })),
    };
  }
}
