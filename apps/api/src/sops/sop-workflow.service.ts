import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ApprovalDecision, Prisma } from '@prisma/client';
import { ApprovalPool } from '../approvals/approval-pool';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { RequestMeta } from '../common/decorators';
import { hasPermission, isFullAccessRole, Permission } from '../common/permissions';
import { markReferenced } from '../media/media-lifecycle';
import { DENIAL_MESSAGES, eligibility } from '../kanbans/kanban-eligibility';
import { isUniqueViolation, PrismaService } from '../prisma/prisma.service';
import { recomputeSopStatus, versionLabel } from './sop-status';
import { SopVersionRepository } from './sop-version.repository';
import { SopsService } from './sops.service';

/** Approval stage a version is waiting on, derived from its state. The state is the single source of truth. */
export type SopStage = 'pre' | 'final';

/**
 * SOP approval state machine, enforced server-side (§7.3 rule 5). Reuses the Kanban approval design
 * (eligibility at action time, group snapshot, blocked state, notifications through ApprovalPool):
 *
 *   DRAFT ──submit──▶ PENDING_PRE_APPROVAL ──pre-approve──▶ PENDING_APPROVAL ──quorum of final approvals──▶ APPROVED ──publish──▶ PUBLISHED
 *     ▲                       │                                   │
 *     └──────reject───────────┴───────────reject──────────────────┘   (round += 1 on resubmission)
 *
 * Approval is quorum-based (organisation setting, default 3). Direct publishing without approval is `finish`.
 */
@Injectable()
export class SopWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: SopVersionRepository,
    private readonly sops: SopsService,
    private readonly audit: AuditService,
    private readonly pool: ApprovalPool,
  ) {}

  // ───────────── commands ─────────────

  async submit(actor: AuthUser, sopId: string, versionId: string, changeSummary: string | undefined, meta: RequestMeta) {
    await this.sops.findSop(actor, sopId);
    // The routing scope is the submitter's groups now. Admins route organisation-wide (empty snapshot).
    const routing = isFullAccessRole(actor.role) ? [] : [...actor.groupIds];
    const { round } = await this.prisma.$transaction(async (tx) => {
      const v = await this.repo.lockDraft(tx, actor.organizationId, sopId, versionId);
      const version = await tx.sopVersion.findUniqueOrThrow({
        where: { id: v.id },
        select: { currentApprovalRound: true, _count: { select: { steps: true } } },
      });
      if (version._count.steps === 0) throw new BadRequestException('Add at least one step before submitting');
      // A version returned to DRAFT by a rejection starts a fresh round on resubmit (Invariant #17).
      const decidedInRound = await tx.sopVersionApproval.count({ where: { sopVersionId: v.id, approvalRound: version.currentApprovalRound } });
      const round = decidedInRound > 0 ? version.currentApprovalRound + 1 : version.currentApprovalRound;
      await tx.sopVersion.update({
        where: { id: v.id },
        data: {
          lifecycleState: 'PENDING_PRE_APPROVAL',
          currentApprovalRound: round,
          submittedById: actor.id,
          submittedAt: new Date(),
          changeSummary: changeSummary ?? undefined,
          routingGroupIds: routing,
        },
      });
      await recomputeSopStatus(tx, sopId);
      await this.audit.record(
        { action: AuditAction.SopVersionSubmitted, organizationId: actor.organizationId, actorId: actor.id, entityType: 'sop_version', entityId: v.id, metadata: { sopId, round, previousState: 'DRAFT', newState: 'PENDING_PRE_APPROVAL', stage: 'pre', routingGroupIds: routing }, ...meta },
        tx,
      );
      return { round };
    });
    await this.notifyStage(actor, sopId, versionId, 'pre', routing, actor.id, round, meta);
    return this.sops.getVersion(actor, sopId, versionId);
  }

  /** Pre-approval: a Pre Approver in the routed group moves the version to final approval. */
  async preApprove(actor: AuthUser, sopId: string, versionId: string, meta: RequestMeta) {
    const v = await this.loadVersion(actor, sopId, versionId);
    await this.authorise(actor, v, 'pre', 'preApprove', meta);
    const round = v.currentApprovalRound;
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.repo.lock(tx, actor.organizationId, sopId, versionId);
      if (locked.lifecycleState !== 'PENDING_PRE_APPROVAL') throw new ConflictException(`Version is ${locked.lifecycleState}, not awaiting pre-approval`);
      await this.recordDecision(tx, actor, sopId, versionId, round, 'pre', 'approved', null);
      await tx.sopVersion.update({ where: { id: versionId }, data: { lifecycleState: 'PENDING_APPROVAL' } });
      await recomputeSopStatus(tx, sopId);
      await this.audit.record(
        { action: AuditAction.SopVersionPreApproved, organizationId: actor.organizationId, actorId: actor.id, entityType: 'sop_version', entityId: versionId, metadata: { sopId, round, previousState: 'PENDING_PRE_APPROVAL', newState: 'PENDING_APPROVAL', stage: 'pre', routingGroupIds: v.routingGroupIds }, ...meta },
        tx,
      );
    });
    await this.notifyStage(actor, sopId, versionId, 'final', v.routingGroupIds, v.submittedById, round, meta);
    return this.sops.getVersion(actor, sopId, versionId);
  }

  /** Rejection at either stage returns the version to DRAFT with the reviewer's comment. */
  async reject(actor: AuthUser, sopId: string, versionId: string, comment: string, meta: RequestMeta) {
    const text = comment.trim();
    if (!text) throw new BadRequestException('A comment is required when rejecting');
    const v = await this.loadVersion(actor, sopId, versionId);
    if (v.lifecycleState !== 'PENDING_PRE_APPROVAL' && v.lifecycleState !== 'PENDING_APPROVAL') {
      throw new ConflictException(`Only a pending version can be rejected (this one is ${v.lifecycleState})`);
    }
    const stage: SopStage = v.lifecycleState === 'PENDING_PRE_APPROVAL' ? 'pre' : 'final';
    await this.authorise(actor, v, stage, 'reject', meta);
    const round = v.currentApprovalRound;
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.repo.lock(tx, actor.organizationId, sopId, versionId);
      if (locked.lifecycleState !== v.lifecycleState) throw new ConflictException('This version was changed by someone else. Reload and try again.');
      await this.recordDecision(tx, actor, sopId, versionId, round, stage, 'rejected', text);
      await tx.sopVersion.update({ where: { id: versionId }, data: { lifecycleState: 'DRAFT' } });
      await recomputeSopStatus(tx, sopId);
      await this.audit.record(
        { action: AuditAction.SopVersionRejected, organizationId: actor.organizationId, actorId: actor.id, entityType: 'sop_version', entityId: versionId, metadata: { sopId, round, stage, previousState: v.lifecycleState, newState: 'DRAFT', comment: text, routingGroupIds: v.routingGroupIds }, ...meta },
        tx,
      );
    });
    await this.notifySubmitter(actor, sopId, versionId, v.submittedById, 'Your SOP change was rejected', `Your change to a SOP was rejected by ${actor.name}.\n\nReason: ${text}\n\nEdit the draft and resubmit when ready.`, meta);
    return this.sops.getVersion(actor, sopId, versionId);
  }

  /**
   * Final approval (quorum). Requires the version to be past pre-approval. Refuses a pre-approval-pending version
   * outright, so the final stage cannot be reached by skipping the pre stage.
   */
  async decide(actor: AuthUser, sopId: string, versionId: string, decision: ApprovalDecision, comment: string | undefined, meta: RequestMeta) {
    if (decision === 'rejected') return this.reject(actor, sopId, versionId, comment ?? '', meta);
    const v = await this.loadVersion(actor, sopId, versionId);
    if (v.lifecycleState !== 'PENDING_PRE_APPROVAL' && v.lifecycleState !== 'PENDING_APPROVAL') {
      throw new ConflictException(`Version is ${v.lifecycleState}, not awaiting approval`);
    }
    // Approver bypass: an eligible final Approver may act while pre-approval is pending. The pre stage is recorded as skipped.
    const bypass = v.lifecycleState === 'PENDING_PRE_APPROVAL';
    await this.authorise(actor, v, 'final', 'approve', meta);
    const round = v.currentApprovalRound;
    let reachedQuorum = false;
    try {
      await this.prisma.$transaction(async (tx) => {
        const locked = await this.repo.lock(tx, actor.organizationId, sopId, versionId);
        if (locked.lifecycleState !== v.lifecycleState) throw new ConflictException('This version was changed by someone else. Reload and try again.');
        if (bypass) {
          await tx.sopVersion.update({ where: { id: versionId }, data: { lifecycleState: 'PENDING_APPROVAL' } });
          await this.audit.record(
            { action: AuditAction.SopVersionPreApprovalSkipped, organizationId: actor.organizationId, actorId: actor.id, entityType: 'sop_version', entityId: versionId, metadata: { sopId, round, reason: 'approver_bypass', skippedBy: actor.id, previousState: 'PENDING_PRE_APPROVAL', newState: 'PENDING_APPROVAL', routingGroupIds: v.routingGroupIds }, ...meta },
            tx,
          );
        }
        await this.recordDecision(tx, actor, sopId, versionId, round, 'final', 'approved', null);
        const settings = await tx.organizationSettings.findUniqueOrThrow({ where: { organizationId: actor.organizationId } });
        const [row] = await tx.$queryRaw<{ n: bigint }[]>`
          SELECT COUNT(DISTINCT approver_id) AS n FROM sop_version_approval
          WHERE sop_version_id = ${versionId}::uuid AND decision = 'approved' AND stage = 'final' AND approval_round = ${round}`;
        const approvals = Number(row.n);
        reachedQuorum = approvals >= settings.approvalQuorum;
        if (reachedQuorum) await tx.sopVersion.update({ where: { id: versionId }, data: { lifecycleState: 'APPROVED', approvedAt: new Date() } });
        await recomputeSopStatus(tx, sopId);
        await this.audit.record(
          { action: AuditAction.SopVersionApproved, organizationId: actor.organizationId, actorId: actor.id, entityType: 'sop_version', entityId: versionId, metadata: { sopId, round, stage: 'final', approvals, quorum: settings.approvalQuorum, quorumReached: reachedQuorum, previousState: bypass ? 'PENDING_PRE_APPROVAL' : 'PENDING_APPROVAL', newState: reachedQuorum ? 'APPROVED' : 'PENDING_APPROVAL', bypassedPreApproval: bypass, routingGroupIds: v.routingGroupIds }, ...meta },
          tx,
        );
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('You have already recorded a decision in this approval round');
      throw e;
    }
    if (reachedQuorum) {
      await this.notifySubmitter(actor, sopId, versionId, v.submittedById, 'Your SOP change was approved', `Your change to a SOP has been approved and is ready to publish.`, meta);
    } else {
      // more final approvals are needed: tell the remaining approvers (transition-based, see notifyStage)
      await this.notifyStage(actor, sopId, versionId, 'final', v.routingGroupIds, v.submittedById, round, meta);
    }
    return this.sops.getVersion(actor, sopId, versionId);
  }

  /** Publish an APPROVED version. Requires publish permission and eligibility on the routed scope (admins are unrestricted). */
  async publish(actor: AuthUser, sopId: string, versionId: string, meta: RequestMeta) {
    await this.sops.findSop(actor, sopId);
    if (!hasPermission(actor, Permission.SopPublish)) throw new ForbiddenException('Publishing requires publish permission');
    const v = await this.loadVersion(actor, sopId, versionId);
    if (v.lifecycleState === 'APPROVED') await this.authorise(actor, v, 'final', 'publish', meta);
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.repo.lock(tx, actor.organizationId, sopId, versionId);
      if (locked.lifecycleState !== 'APPROVED') throw new ConflictException(`Only APPROVED versions can be published (this one is ${locked.lifecycleState})`);
      await tx.sopVersion.update({
        where: { id: versionId },
        data: { lifecycleState: 'PUBLISHED', publishedById: actor.id, publishedAt: new Date() },
      });
      await tx.sop.update({ where: { id: sopId }, data: { currentPublishedVersionId: versionId } });
      const media = await tx.sopStepMedia.findMany({ where: { sopStep: { sopVersionId: versionId } }, select: { mediaAssetId: true } });
      await markReferenced(tx, media.map((m) => m.mediaAssetId));
      await recomputeSopStatus(tx, sopId);
      await this.audit.record(
        { action: AuditAction.SopVersionPublished, organizationId: actor.organizationId, actorId: actor.id, entityType: 'sop_version', entityId: versionId, metadata: { sopId, previousState: 'APPROVED', newState: 'PUBLISHED', directPublish: false }, ...meta },
        tx,
      );
    });
    if (v.submittedById && v.submittedById !== actor.id) {
      await this.notifySubmitter(actor, sopId, versionId, v.submittedById, 'Your SOP change was published', `${actor.name} published your change to a SOP.`, meta);
    }
    // Pre-render the one canonical PDF in the background (§9); first request falls back to inline rendering.
    return this.sops.getVersion(actor, sopId, versionId);
  }

  /**
   * "Finish & Save" when the organization does not require approval. Publishing is a publish-level action whatever the
   * approval setting: the absence of approval never bypasses sop.publish. Behaviour is otherwise unchanged.
   */
  async finish(actor: AuthUser, sopId: string, versionId: string, changeSummary: string | undefined, meta: RequestMeta) {
    // Publishing is a publish-level action whatever the approval setting: the absence of approval never bypasses sop.publish.
    if (!hasPermission(actor, Permission.SopPublish)) throw new ForbiddenException('Publishing requires publish permission');
    await this.sops.findSop(actor, sopId);
    const settings = await this.prisma.organizationSettings.findUniqueOrThrow({ where: { organizationId: actor.organizationId } });
    if (settings.approvalRequired) {
      throw new ForbiddenException('This organization requires approval before publishing — submit the version for approval instead');
    }
    await this.prisma.$transaction(async (tx) => {
      const v = await this.repo.lockDraft(tx, actor.organizationId, sopId, versionId);
      const steps = await tx.sopStep.count({ where: { sopVersionId: v.id } });
      if (steps === 0) throw new BadRequestException('Add at least one step before publishing');
      const now = new Date();
      await tx.sopVersion.update({
        where: { id: v.id },
        data: {
          lifecycleState: 'PUBLISHED',
          changeSummary: changeSummary ?? undefined,
          submittedById: actor.id,
          submittedAt: now,
          publishedById: actor.id,
          publishedAt: now,
        },
      });
      await tx.sop.update({ where: { id: sopId }, data: { currentPublishedVersionId: v.id } });
      const media = await tx.sopStepMedia.findMany({ where: { sopStep: { sopVersionId: v.id } }, select: { mediaAssetId: true } });
      await markReferenced(tx, media.map((m) => m.mediaAssetId));
      await recomputeSopStatus(tx, sopId);
      await this.audit.record(
        { action: AuditAction.SopVersionPublished, organizationId: actor.organizationId, actorId: actor.id, entityType: 'sop_version', entityId: v.id, metadata: { sopId, approval: 'not_required', directPublish: true }, ...meta },
        tx,
      );
    });
    return this.sops.getVersion(actor, sopId, versionId);
  }

  // ───────────── reads ─────────────

  /** Full, immutable decision history across all rounds, plus the current stage, routing and what this actor can do. */
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
    const stage = stageOf(v.lifecycleState);
    const routing = await this.routingView(v.routingGroupIds);
    const blocked = stage ? await this.blockedFor(actor.organizationId, versionId, v.routingGroupIds, v.submittedById, stage, v.currentApprovalRound, settings.approvalQuorum) : false;
    const quorum = await this.quorumView(actor, versionId, v, settings.approvalQuorum);
    const skipped = await this.prisma.auditLog.findFirst({
      where: { organizationId: actor.organizationId, action: AuditAction.SopVersionPreApprovalSkipped, entityId: versionId, AND: [{ metadata: { path: ['round'], equals: v.currentApprovalRound } }] },
      orderBy: { occurredAt: 'desc' },
    });
    return {
      versionId,
      quorum,
      preApprovalSkipped: !!skipped,
      preApprovalSkippedBy: skipped ? (skipped.metadata as { skippedBy?: string }).skippedBy ?? null : null,
      label: versionLabel(v.versionSequence),
      lifecycleState: v.lifecycleState,
      stage,
      currentApprovalRound: v.currentApprovalRound,
      approvedInCurrentRound: new Set(current.filter((r) => r.decision === 'approved' && r.stage === 'final').map((r) => r.approverId)).size,
      submittedById: v.submittedById,
      allowSelfApproval: settings.allowSelfApproval,
      routingGroups: routing,
      blocked,
      blockedReason: blocked ? blockedReason(stage!) : null,
      actions: this.actionsFor(actor, v, settings.allowSelfApproval),
      decisions: rows.map((r) => ({
        id: r.id,
        round: r.approvalRound,
        stage: r.stage,
        decision: r.decision,
        comment: r.comment,
        createdAt: r.createdAt,
        approver: byId.get(r.approverId) ?? { id: r.approverId, name: 'Unknown user' },
      })),
    };
  }

  /**
   * Approval inbox. Scoped to what the caller can act on or needs to know: actionable pre-approvals and final approvals,
   * approved versions they can publish, blocked stages (Admins and the submitter), rejections of their own submissions,
   * and their own open submissions. Never the organisation's full list for filtering in the browser.
   */
  async inbox(actor: AuthUser) {
    const settings = await this.prisma.organizationSettings.findUniqueOrThrow({ where: { organizationId: actor.organizationId } });
    const versions = await this.prisma.sopVersion.findMany({
      where: { organizationId: actor.organizationId, lifecycleState: { in: ['PENDING_PRE_APPROVAL', 'PENDING_APPROVAL', 'APPROVED'] }, sop: { deletedAt: null } },
      include: { sop: { select: { id: true, name: true, referenceNo: true } } },
      orderBy: { submittedAt: 'desc' },
      take: 200,
    });
    const names = await this.userNames([...new Set(versions.map((v) => v.submittedById).filter((x): x is string => !!x))]);
    const groupNames = await this.groupNameMap([...new Set(versions.flatMap((v) => v.routingGroupIds))]);
    const out = { preApproval: [] as object[], finalApproval: [] as object[], readyToPublish: [] as object[], blocked: [] as object[], rejected: [] as object[], mine: [] as object[] };

    for (const v of versions) {
      const actions = this.actionsFor(actor, v, settings.allowSelfApproval);
      const stage = stageOf(v.lifecycleState);
      const blocked = stage ? await this.blockedFor(actor.organizationId, v.id, v.routingGroupIds, v.submittedById, stage, v.currentApprovalRound, settings.approvalQuorum) : false;
      const item = {
        sopId: v.sopId,
        versionId: v.id,
        name: v.sop.name,
        referenceNo: v.sop.referenceNo,
        label: versionLabel(v.versionSequence),
        state: v.lifecycleState,
        stage,
        submitter: v.submittedById ? { id: v.submittedById, name: names.get(v.submittedById) ?? null } : null,
        submittedAt: v.submittedAt,
        routingGroups: v.routingGroupIds.map((id) => ({ id, name: groupNames.get(id) ?? null })),
        blocked,
        blockedReason: blocked && stage ? blockedReason(stage) : null,
        actions,
      };
      if (v.submittedById === actor.id) out.mine.push(item);
      if (blocked && (isFullAccessRole(actor.role) || v.submittedById === actor.id)) out.blocked.push(item);
      if (v.lifecycleState === 'PENDING_PRE_APPROVAL' && actions.preApprove) out.preApproval.push(item);
      if ((v.lifecycleState === 'PENDING_PRE_APPROVAL' || v.lifecycleState === 'PENDING_APPROVAL') && actions.approve) out.finalApproval.push(item);
      if (v.lifecycleState === 'APPROVED' && actions.publish) out.readyToPublish.push(item);
    }

    // Rejections of the caller's own submissions: drafts sent back with a reason in the current round.
    const returned = await this.prisma.sopVersion.findMany({
      where: { organizationId: actor.organizationId, lifecycleState: 'DRAFT', submittedById: actor.id, sop: { deletedAt: null } },
      include: { sop: { select: { id: true, name: true, referenceNo: true } } },
      take: 100,
    });
    for (const v of returned) {
      const rejection = await this.prisma.sopVersionApproval.findFirst({
        where: { sopVersionId: v.id, approvalRound: v.currentApprovalRound, decision: 'rejected' },
        orderBy: { createdAt: 'desc' },
      });
      if (!rejection) continue;
      out.rejected.push({ sopId: v.sopId, versionId: v.id, name: v.sop.name, referenceNo: v.sop.referenceNo, label: versionLabel(v.versionSequence), state: v.lifecycleState, stage: null, comment: rejection.comment, rejectedAt: rejection.createdAt, actions: {} });
    }
    return out;
  }

  // ───────────── internals ─────────────

  /** Loads a version for this tenant and parent SOP, or 404. */
  private async loadVersion(actor: AuthUser, sopId: string, versionId: string) {
    await this.sops.findSop(actor, sopId);
    const v = await this.prisma.sopVersion.findFirst({ where: { id: versionId, sopId, organizationId: actor.organizationId } });
    if (!v) throw new NotFoundException('Version not found');
    return v;
  }

  /**
   * Action-time authorisation. The permission for the stage and the routed scope are checked against the actor's
   * CURRENT permissions and groups (never the historical snapshot alone). Denials are audited, then refused.
   */
  private async authorise(actor: AuthUser, v: { id: string; submittedById: string | null; routingGroupIds: string[]; currentApprovalRound: number }, stage: SopStage, action: 'preApprove' | 'approve' | 'reject' | 'publish', meta: RequestMeta) {
    const permission = action === 'publish' ? Permission.SopPublish : stage === 'pre' ? Permission.SopPreApprove : action === 'reject' ? Permission.SopReview : Permission.SopApprove;
    const settings = await this.prisma.organizationSettings.findUniqueOrThrow({ where: { organizationId: actor.organizationId }, select: { allowSelfApproval: true } });
    const denial = eligibility(actor, {
      routingGroupIds: v.routingGroupIds,
      submittedById: v.submittedById,
      permission,
      allowSelfApproval: settings.allowSelfApproval,
      isPublish: action === 'publish',
    });
    if (denial) {
      await this.audit.record({ action: AuditAction.SopVersionDenied, organizationId: actor.organizationId, actorId: actor.id, entityType: 'sop_version', entityId: v.id, metadata: { attempted: action, stage, reason: denial, round: v.currentApprovalRound }, ...meta });
      throw new ForbiddenException(DENIAL_MESSAGES[denial]);
    }
  }

  /** What this actor could do with the version right now. Read-only; the server re-checks on the action itself. */
  private actionsFor(actor: AuthUser, v: { lifecycleState: string; submittedById: string | null; routingGroupIds: string[] }, allowSelfApproval: boolean) {
    const can = (permission: Permission, isPublish = false) =>
      !eligibility(actor, { routingGroupIds: v.routingGroupIds, submittedById: v.submittedById, permission, allowSelfApproval, isPublish });
    const pending = v.lifecycleState === 'PENDING_PRE_APPROVAL' || v.lifecycleState === 'PENDING_APPROVAL';
    return {
      preApprove: v.lifecycleState === 'PENDING_PRE_APPROVAL' && can(Permission.SopPreApprove),
      approve: (v.lifecycleState === 'PENDING_PRE_APPROVAL' || v.lifecycleState === 'PENDING_APPROVAL') && can(Permission.SopApprove),
      reject: pending && (v.lifecycleState === 'PENDING_PRE_APPROVAL' ? can(Permission.SopPreApprove) : can(Permission.SopApprove)),
      publish: v.lifecycleState === 'APPROVED' && hasPermission(actor, Permission.SopPublish) && can(Permission.SopPublish, true),
    };
  }

  /** Records one decision (immutable row). The unique key includes the stage, so pre and final decisions never collide. */
  private async recordDecision(tx: Prisma.TransactionClient, actor: AuthUser, sopId: string, versionId: string, round: number, stage: SopStage, decision: ApprovalDecision, comment: string | null) {
    await tx.sopVersionApproval.create({
      data: {
        organizationId: actor.organizationId,
        sopVersionId: versionId,
        approvalRound: round,
        approverId: actor.id,
        stage,
        decision,
        comment,
      },
    });
  }

  /**
   * Notifies eligible approvers for the stage, scoped to the routed groups. When nobody is eligible the version is
   * blocked: Admins are notified once per (version, round, stage), and the inbox shows the state from then on.
   */
  private async notifyStage(actor: AuthUser, sopId: string, versionId: string, stage: SopStage, routing: string[], submitterId: string | null, round: number, meta: RequestMeta) {
    const perm = stage === 'pre' ? Permission.SopPreApprove : Permission.SopApprove;
    const pool = await this.pool.members(actor.organizationId, perm, routing, submitterId);
    const sop = await this.prisma.sop.findUniqueOrThrow({ where: { id: sopId }, select: { name: true, referenceNo: true } });
    const group = routing.length ? [...(await this.groupNameMap(routing)).values()].join(', ') : 'organisation-wide';
    const settings = await this.prisma.organizationSettings.findUniqueOrThrow({ where: { organizationId: actor.organizationId }, select: { approvalQuorum: true } });
    const capacity = await this.capacityFor(actor.organizationId, versionId, routing, submitterId, stage, round, settings.approvalQuorum);
    if (capacity.available < capacity.remaining) {
      await this.markBlocked(actor, sopId, versionId, stage, round, group, sop.name, meta, capacity.available === 0 ? 'no_eligible_approver' : 'insufficient_approvers');
      return;
    }
    await this.pool.notify(
      actor.organizationId,
      pool,
      { entityType: 'sop_version', entityId: versionId },
      stage === 'pre'
        ? { subject: `SOP requires your pre-approval: ${sop.name}`, text: `${actor.name} submitted "${sop.name}" (${sop.referenceNo}) for pre-approval.\nGroup: ${group}.` }
        : { subject: `SOP passed pre-approval: ${sop.name}`, text: `"${sop.name}" (${sop.referenceNo}) passed pre-approval and requires final approval.\nGroup: ${group}.` },
    );
  }

  /** Blocked transition: audited and sent to Admins once per (version, round, stage). Later repeats are no-ops. */
  private async markBlocked(actor: AuthUser, sopId: string, versionId: string, stage: SopStage, round: number, group: string, sopName: string, meta: RequestMeta, reason: 'no_eligible_approver' | 'insufficient_approvers') {
    const already = await this.prisma.auditLog.findFirst({
      where: {
        organizationId: actor.organizationId,
        action: AuditAction.SopVersionBlocked,
        entityId: versionId,
        AND: [{ metadata: { path: ['stage'], equals: stage } }, { metadata: { path: ['round'], equals: round } }],
      },
      select: { id: true },
    });
    if (already) return;
    await this.audit.record({ action: AuditAction.SopVersionBlocked, organizationId: actor.organizationId, actorId: actor.id, entityType: 'sop_version', entityId: versionId, metadata: { sopId, round, stage, reason, routingGroups: group, state: stage === 'pre' ? 'PENDING_PRE_APPROVAL' : 'PENDING_APPROVAL' }, ...meta });
    const admins = await this.pool.admins(actor.organizationId);
    await this.pool.notify(actor.organizationId, admins, { entityType: 'sop_version', entityId: versionId }, {
      subject: `Approval blocked: no ${stage === 'pre' ? 'Pre Approver' : 'Approver'} for ${sopName}`,
      text: `"${sopName}" is waiting for ${stage === 'pre' ? 'pre-approval' : 'final approval'}, but no eligible ${stage === 'pre' ? 'Pre Approver' : 'Approver'} currently exists for its group (${group}).\n\nIt stays pending until one is available. Assign a user with the right role and group, or act on it yourself.`,
    });
  }

  /**
   * Blocked = the stage cannot progress with the people currently eligible. Pre-approval: no eligible Pre Approver.
   * Final: fewer eligible approvers who have not yet voted than approvals still needed for quorum. Admins are an override,
   * not pool members.
   */
  private async blockedFor(organizationId: string, versionId: string, routing: string[], submitterId: string | null, stage: SopStage, round: number, quorum: number): Promise<boolean> {
    const capacity = await this.capacityFor(organizationId, versionId, routing, submitterId, stage, round, quorum);
    return capacity.available < capacity.remaining;
  }

  /** Eligible approvers still able to act, against the approvals still needed. Pre-approval needs one; final needs the quorum shortfall. */
  private async capacityFor(organizationId: string, versionId: string, routing: string[], submitterId: string | null, stage: SopStage, round: number, quorum: number) {
    const perm = stage === 'pre' ? Permission.SopPreApprove : Permission.SopApprove;
    const pool = await this.pool.members(organizationId, perm, routing, submitterId);
    if (stage === 'pre') return { available: pool.length, remaining: 1, eligible: pool.length, voted: 0 };
    const voters = await this.finalVoters(organizationId, versionId, round);
    const available = pool.filter((m) => !voters.has(m.id)).length;
    return { available, remaining: Math.max(0, quorum - voters.size), eligible: pool.length, voted: voters.size };
  }

  /** Distinct final approvers in this round. A duplicate vote cannot count twice (unique key + distinct count). */
  private async finalVoters(organizationId: string, versionId: string, round: number): Promise<Set<string>> {
    const rows = await this.prisma.sopVersionApproval.findMany({
      where: { organizationId, sopVersionId: versionId, approvalRound: round, stage: 'final', decision: 'approved' },
      select: { approverId: true },
    });
    return new Set(rows.map((r) => r.approverId));
  }

  /** Quorum progress for the UI. The quorum value is read from organisation settings in one place, so it can become configurable without touching the workflow. */
  private async quorumView(actor: AuthUser, versionId: string, v: { currentApprovalRound: number; submittedById: string | null; routingGroupIds: string[]; lifecycleState: string }, required: number) {
    const voters = await this.finalVoters(actor.organizationId, versionId, v.currentApprovalRound);
    const stage = stageOf(v.lifecycleState) ?? 'final';
    const capacity = await this.capacityFor(actor.organizationId, versionId, v.routingGroupIds, v.submittedById, 'final', v.currentApprovalRound, required);
    const current = voters.size;
    return {
      required,
      current,
      remaining: Math.max(0, required - current),
      eligibleApproverCount: capacity.eligible,
      availableApproverCount: capacity.available,
      currentUserApproved: voters.has(actor.id),
      currentUserCanApprove: !voters.has(actor.id) && (await this.canApproveNow(actor, v)),
      stage,
    };
  }

  private async canApproveNow(actor: AuthUser, v: { lifecycleState: string; submittedById: string | null; routingGroupIds: string[] }) {
    const settings = await this.prisma.organizationSettings.findUniqueOrThrow({ where: { organizationId: actor.organizationId }, select: { allowSelfApproval: true } });
    return this.actionsFor(actor, v, settings.allowSelfApproval).approve;
  }

  private async notifySubmitter(actor: AuthUser, sopId: string, versionId: string, submitterId: string | null, subject: string, text: string, _meta: RequestMeta) {
    if (!submitterId) return;
    const u = await this.prisma.user.findFirst({ where: { id: submitterId, organizationId: actor.organizationId }, select: { id: true, name: true, email: true, orgRole: true } });
    if (!u) return;
    await this.pool.notify(actor.organizationId, [{ ...u, groupIds: [] }], { entityType: 'sop_version', entityId: versionId }, { subject, text: `${text}\n\nSOP id: ${sopId}` });
  }

  private async userNames(ids: string[]) {
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private async groupNameMap(ids: string[]) {
    if (!ids.length) return new Map<string, string>();
    const groups = await this.prisma.userGroup.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    return new Map(groups.map((g) => [g.id, g.name]));
  }

  private async routingView(ids: string[]) {
    const names = await this.groupNameMap(ids);
    return ids.map((id) => ({ id, name: names.get(id) ?? null }));
  }
}

/** Stage from state: pre-approval, final approval, or none. */
function stageOf(state: string): SopStage | null {
  if (state === 'PENDING_PRE_APPROVAL') return 'pre';
  if (state === 'PENDING_APPROVAL') return 'final';
  return null;
}

function blockedReason(stage: SopStage): string {
  return stage === 'pre'
    ? 'Waiting for pre-approval, but no eligible Pre Approver exists for this group. Admins have been notified.'
    : 'Waiting for final approval, but no eligible Approver exists for this group. Admins have been notified.';
}
