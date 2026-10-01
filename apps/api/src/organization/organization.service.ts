import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { RequestMeta } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { AuditQueryDto, UpdateSettingsDto } from './organization.dto';

/** Proposed default (§7.7, §18 "can be deferred"). Move to OrganizationSettings when made configurable. */
export const DELETION_COOLDOWN_DAYS = 14;

@Injectable()
export class OrganizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(actor: AuthUser) {
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: actor.organizationId },
      include: { settings: true },
    });
    return {
      id: org.id,
      name: org.name,
      status: org.status,
      deletionScheduledFor: org.deletionScheduledFor,
      settings: org.settings && {
        approvalRequired: org.settings.approvalRequired,
        approvalQuorum: org.settings.approvalQuorum,
        allowSelfApproval: org.settings.allowSelfApproval,
        publicSopViewing: org.settings.publicSopViewing,
        updatedAt: org.settings.updatedAt,
      },
    };
  }

  async updateSettings(actor: AuthUser, dto: UpdateSettingsDto, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.organizationSettings.findUniqueOrThrow({ where: { organizationId: actor.organizationId } });
      const after = await tx.organizationSettings.update({ where: { organizationId: actor.organizationId }, data: dto });
      await this.audit.record(
        {
          action: AuditAction.OrgSettingsChanged,
          organizationId: actor.organizationId,
          actorId: actor.id,
          entityType: 'organization_settings',
          entityId: actor.organizationId,
          metadata: {
            before: { approvalRequired: before.approvalRequired, approvalQuorum: before.approvalQuorum, allowSelfApproval: before.allowSelfApproval, publicSopViewing: before.publicSopViewing },
            after: { approvalRequired: after.approvalRequired, approvalQuorum: after.approvalQuorum, allowSelfApproval: after.allowSelfApproval, publicSopViewing: after.publicSopViewing },
          },
          ...meta,
        },
        tx,
      );
    });
    return this.get(actor);
  }

  async listAudit(actor: AuthUser, q: AuditQueryDto) {
    const where: Prisma.AuditLogWhereInput = { organizationId: actor.organizationId };
    if (q.action) where.action = { startsWith: q.action };
    if (q.before) {
      const d = new Date(q.before);
      if (Number.isNaN(d.getTime())) throw new BadRequestException('Invalid "before" timestamp');
      where.occurredAt = { lt: d };
    }
    const limit = q.limit ?? 50;
    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      take: limit,
    });
    const actorIds = [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))];
    const actors = await this.prisma.user.findMany({
      where: { id: { in: actorIds }, organizationId: actor.organizationId },
      select: { id: true, name: true, email: true },
    });
    const byId = new Map(actors.map((a) => [a.id, a]));
    return {
      items: rows.map((r) => ({ ...r, actor: r.actorId ? byId.get(r.actorId) ?? null : null })),
      nextBefore: rows.length === limit ? rows[rows.length - 1].occurredAt.toISOString() : null,
    };
  }

  /** §7.7: explicit name confirmation + password re-auth → cancellable cooldown. */
  async requestDeletion(actor: AuthUser, confirmName: string, password: string, meta: RequestMeta) {
    const [org, user] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({ where: { id: actor.organizationId } }),
      this.prisma.user.findUniqueOrThrow({ where: { id: actor.id } }),
    ]);
    if (org.status !== 'active') throw new BadRequestException('Deletion already requested');
    if (confirmName !== org.name) throw new BadRequestException('Organization name does not match');
    if (!user.passwordHash || !(await argon2.verify(user.passwordHash, password).catch(() => false))) {
      throw new UnauthorizedException('Password is incorrect');
    }
    const scheduled = new Date(Date.now() + DELETION_COOLDOWN_DAYS * 86_400_000);
    await this.prisma.$transaction(async (tx) => {
      await tx.organization.update({
        where: { id: org.id },
        data: { status: 'pending_deletion', deletionRequestedAt: new Date(), deletionScheduledFor: scheduled },
      });
      await this.audit.record(
        { action: AuditAction.OrgDeletionRequested, organizationId: org.id, actorId: actor.id, entityType: 'organization', entityId: org.id, metadata: { scheduledFor: scheduled.toISOString() }, ...meta },
        tx,
      );
    });
    return this.get(actor);
  }

  async cancelDeletion(actor: AuthUser, meta: RequestMeta) {
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: actor.organizationId } });
    if (org.status !== 'pending_deletion') throw new BadRequestException('No pending deletion');
    await this.prisma.$transaction(async (tx) => {
      await tx.organization.update({
        where: { id: org.id },
        data: { status: 'active', deletionRequestedAt: null, deletionScheduledFor: null },
      });
      await this.audit.record(
        { action: AuditAction.OrgDeletionCancelled, organizationId: org.id, actorId: actor.id, entityType: 'organization', entityId: org.id, ...meta },
        tx,
      );
    });
    return this.get(actor);
  }
}
