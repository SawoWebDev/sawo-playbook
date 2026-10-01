import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SkillAssessment } from '@prisma/client';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { RequestMeta } from '../common/decorators';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { versionLabel } from '../sops/sop-status';

/** §6.8 — five competency states, values 0–4. */
export const SKILL_LEVELS = [
  'No Training',
  'Knows Basic Principles',
  'Demonstrates Basic Principles',
  'Able to Work Alone',
  'Able to Train Others',
] as const;

export interface AssessInput {
  associateId: string;
  sopId: string;
  level: number;
  sopVersionId?: string;
  notes?: string;
}

@Injectable()
export class SkillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ───────────── visibility (§7.2 field-level rules, §7.3 rule 4) ─────────────

  /** Associate ids whose rows the actor may see, or `null` for "all in org". */
  private async visibleAssociates(actor: AuthUser): Promise<string[] | null> {
    // Admins and Editors record training for everyone; (retired) Trainers see their trainees; Viewers their own row.
    if (actor.role === 'OWNER' || actor.role === 'ADMIN' || actor.role === 'EDITOR') return null;
    if (actor.role === 'TRAINER') {
      const rows = await this.prisma.trainerAssignment.findMany({
        where: { organizationId: actor.organizationId, trainerId: actor.id },
        select: { associateId: true },
      });
      return [actor.id, ...rows.map((r) => r.associateId)];
    }
    return [actor.id]; // Operator/Viewer: own row only, read-only
  }

  private async assertCanAssess(actor: AuthUser, associateId: string) {
    if (associateId === actor.id) throw new ForbiddenException('You cannot assess yourself');
    if (actor.role === 'TRAINER') {
      const assigned = await this.prisma.trainerAssignment.findUnique({
        where: { trainerId_associateId: { trainerId: actor.id, associateId } },
      });
      if (!assigned || assigned.organizationId !== actor.organizationId) {
        throw new ForbiddenException('You can only assess your assigned trainees');
      }
    }
  }

  private async findAssociate(actor: AuthUser, id: string) {
    const u = await this.prisma.user.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!u) throw new NotFoundException('Associate not found');
    return u;
  }

  // ───────────── matrix & history ─────────────

  async matrix(actor: AuthUser, q: { folderId?: string; role?: string }) {
    const visible = await this.visibleAssociates(actor);
    const sops = await this.prisma.sop.findMany({
      where: {
        organizationId: actor.organizationId,
        deletedAt: null,
        archivedAt: null,
        currentPublishedVersionId: { not: null },
        ...(q.folderId ? { folderId: q.folderId } : {}),
      },
      orderBy: { referenceNo: 'asc' },
      select: { id: true, name: true, referenceNo: true, currentPublishedVersion: { select: { id: true, versionSequence: true } } },
    });
    const associates = await this.prisma.user.findMany({
      where: {
        organizationId: actor.organizationId,
        status: 'active',
        ...(visible ? { id: { in: visible } } : {}),
        ...(q.role ? { orgRole: q.role as Prisma.EnumOrgRoleFilter['equals'] } : {}),
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, orgRole: true },
    });
    const records = await this.prisma.skillRecord.findMany({
      where: { organizationId: actor.organizationId, associateId: { in: associates.map((a) => a.id) }, sopId: { in: sops.map((s) => s.id) } },
      include: { sopVersion: { select: { versionSequence: true } }, lastAssessment: { select: { assessedAt: true } } },
    });
    const currentBySop = new Map(sops.map((s) => [s.id, s.currentPublishedVersion?.id]));
    const assignments = await this.prisma.trainerAssignment.findMany({
      where: { organizationId: actor.organizationId, trainerId: actor.id },
      select: { associateId: true },
    });
    const myTrainees = new Set(assignments.map((a) => a.associateId));
    return {
      levels: SKILL_LEVELS.map((label, value) => ({ value, label })),
      sops: sops.map((s) => ({
        id: s.id,
        name: s.name,
        referenceNo: s.referenceNo,
        currentVersionId: s.currentPublishedVersion!.id,
        currentVersionLabel: versionLabel(s.currentPublishedVersion!.versionSequence),
      })),
      associates: associates.map((a) => ({
        id: a.id,
        name: a.name,
        role: a.orgRole,
        editable:
          a.id !== actor.id &&
          (actor.role === 'OWNER' || actor.role === 'ADMIN' || actor.role === 'EDITOR' || (actor.role === 'TRAINER' && myTrainees.has(a.id))),
      })),
      cells: records.map((r) => ({
        associateId: r.associateId,
        sopId: r.sopId,
        level: r.currentLevel,
        sopVersionId: r.currentSopVersionId,
        versionLabel: versionLabel(r.sopVersion.versionSequence),
        // assessed against an older version than the one currently published
        outdated: r.currentSopVersionId !== currentBySop.get(r.sopId),
        assessedAt: r.lastAssessment.assessedAt,
      })),
    };
  }

  async history(actor: AuthUser, q: { associateId?: string; sopId?: string }) {
    const visible = await this.visibleAssociates(actor);
    if (q.associateId && visible && !visible.includes(q.associateId)) throw new NotFoundException('Associate not found');
    const where: Prisma.SkillAssessmentWhereInput = { organizationId: actor.organizationId };
    if (q.associateId) where.associateId = q.associateId;
    else if (visible) where.associateId = { in: visible };
    if (q.sopId) where.sopId = q.sopId;
    const rows = await this.prisma.skillAssessment.findMany({
      where,
      orderBy: { assessedAt: 'desc' },
      take: 500,
      include: { sop: { select: { id: true, name: true, referenceNo: true } }, sopVersion: { select: { versionSequence: true } } },
    });
    const people = await this.prisma.user.findMany({
      where: { organizationId: actor.organizationId, id: { in: [...new Set(rows.flatMap((r) => [r.associateId, r.trainerId]))] } },
      select: { id: true, name: true },
    });
    const byId = new Map(people.map((p) => [p.id, p]));
    return rows.map((r) => ({
      id: r.id,
      associate: byId.get(r.associateId) ?? { id: r.associateId, name: 'Unknown' },
      trainer: byId.get(r.trainerId) ?? { id: r.trainerId, name: 'Unknown' },
      sop: r.sop,
      sopVersionId: r.sopVersionId,
      versionLabel: versionLabel(r.sopVersion.versionSequence),
      level: r.level,
      levelLabel: SKILL_LEVELS[r.level],
      assessedAt: r.assessedAt,
      notes: r.notes,
    }));
  }

  // ───────────── assess (single-transaction rule, §6.8) ─────────────

  async assess(actor: AuthUser, input: AssessInput, meta: RequestMeta) {
    if (!Number.isInteger(input.level) || input.level < 0 || input.level > 4) throw new BadRequestException('level must be 0–4');
    const associate = await this.findAssociate(actor, input.associateId);
    if (associate.status !== 'active') throw new BadRequestException('Associate is not active');
    await this.assertCanAssess(actor, associate.id);

    const sop = await this.prisma.sop.findFirst({ where: { id: input.sopId, organizationId: actor.organizationId, deletedAt: null } });
    if (!sop) throw new NotFoundException('SOP not found');
    // Invariant #7: pinned to the exact PUBLISHED version assessed against.
    const versionId = input.sopVersionId ?? sop.currentPublishedVersionId;
    if (!versionId) throw new BadRequestException('SOP has no published version to assess against');
    const version = await this.prisma.sopVersion.findFirst({
      where: { id: versionId, sopId: sop.id, organizationId: actor.organizationId, lifecycleState: 'PUBLISHED' },
    });
    if (!version) throw new BadRequestException('Assessments must reference a published version of this SOP');

    const assessment = await this.prisma.$transaction(async (tx) => {
      const a = await tx.skillAssessment.create({
        data: {
          organizationId: actor.organizationId,
          associateId: associate.id,
          sopId: sop.id,
          sopVersionId: version.id,
          level: input.level,
          trainerId: actor.id,
          notes: input.notes?.trim() || null,
        },
      });
      // If the projection fails, the whole transaction — including the insert above — rolls back.
      await this.projectRecord(tx, a);
      await this.audit.record(
        {
          action: AuditAction.SkillAssessed,
          organizationId: actor.organizationId,
          actorId: actor.id,
          entityType: 'skill_assessment',
          entityId: a.id,
          metadata: { associateId: associate.id, sopId: sop.id, sopVersionId: version.id, level: input.level },
          ...meta,
        },
        tx,
      );
      return a;
    });
    return { id: assessment.id, level: assessment.level, sopVersionId: assessment.sopVersionId, assessedAt: assessment.assessedAt };
  }

  /** Current-state projection: one SkillRecord per associate+SOP. Exposed for the rollback test. */
  async projectRecord(tx: Tx, a: SkillAssessment): Promise<void> {
    await tx.skillRecord.upsert({
      where: { associateId_sopId: { associateId: a.associateId, sopId: a.sopId } },
      create: {
        organizationId: a.organizationId,
        associateId: a.associateId,
        sopId: a.sopId,
        currentLevel: a.level,
        currentSopVersionId: a.sopVersionId,
        lastAssessmentId: a.id,
      },
      update: { currentLevel: a.level, currentSopVersionId: a.sopVersionId, lastAssessmentId: a.id },
    });
  }

  /** Explicit repair: rebuild every SkillRecord of the org from full SkillAssessment history. */
  async rebuild(actor: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const latest = await tx.$queryRaw<SkillAssessment[]>`
        SELECT DISTINCT ON (associate_id, sop_id)
          id, organization_id AS "organizationId", associate_id AS "associateId", sop_id AS "sopId",
          sop_version_id AS "sopVersionId", level, trainer_id AS "trainerId", assessed_at AS "assessedAt", notes
        FROM skill_assessment
        WHERE organization_id = ${actor.organizationId}::uuid
        ORDER BY associate_id, sop_id, assessed_at DESC, id DESC`;
      await tx.skillRecord.deleteMany({ where: { organizationId: actor.organizationId } });
      for (const a of latest) await this.projectRecord(tx, a);
      return { rebuilt: latest.length };
    });
  }

  // ───────────── trainer assignments ─────────────

  async listAssignments(actor: AuthUser) {
    const where: Prisma.TrainerAssignmentWhereInput = { organizationId: actor.organizationId };
    if (actor.role === 'TRAINER') where.trainerId = actor.id;
    const rows = await this.prisma.trainerAssignment.findMany({ where, orderBy: { createdAt: 'asc' } });
    const people = await this.prisma.user.findMany({
      where: { organizationId: actor.organizationId, id: { in: [...new Set(rows.flatMap((r) => [r.trainerId, r.associateId]))] } },
      select: { id: true, name: true },
    });
    const byId = new Map(people.map((p) => [p.id, p]));
    return rows.map((r) => ({ trainer: byId.get(r.trainerId), associate: byId.get(r.associateId), createdAt: r.createdAt }));
  }

  async assign(actor: AuthUser, trainerId: string, associateId: string) {
    const [trainer, associate] = await Promise.all([this.findAssociate(actor, trainerId), this.findAssociate(actor, associateId)]);
    if (trainer.orgRole !== 'TRAINER') throw new BadRequestException('The selected user does not have the Trainer role');
    if (trainer.id === associate.id) throw new BadRequestException('A trainer cannot be assigned to themselves');
    try {
      await this.prisma.trainerAssignment.create({
        data: { organizationId: actor.organizationId, trainerId: trainer.id, associateId: associate.id, assignedById: actor.id },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Already assigned');
      throw e;
    }
    return this.listAssignments(actor);
  }

  async unassign(actor: AuthUser, trainerId: string, associateId: string) {
    const r = await this.prisma.trainerAssignment.deleteMany({ where: { organizationId: actor.organizationId, trainerId, associateId } });
    if (!r.count) throw new NotFoundException('Assignment not found');
  }
}
