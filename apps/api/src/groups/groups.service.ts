import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { RequestMeta } from '../common/decorators';
import { isFullAccessRole } from '../common/permissions';
import { isUniqueViolation, PrismaService } from '../prisma/prisma.service';

/** Workflow states whose routing snapshot may point at a group. A group they route to cannot be deleted. */
const OPEN_KANBAN_STATES = ['DRAFT', 'PENDING_PRE_APPROVAL', 'PRE_APPROVED', 'APPROVED'] as const;
const OPEN_SOP_STATES = ['PENDING_PRE_APPROVAL', 'PENDING_APPROVAL', 'APPROVED'] as const;

/**
 * Organisation groups. They scope approval routing only; content does not belong to a group.
 * Every query is scoped to the caller's organisation, so another tenant's group reads as not found.
 */
@Injectable()
export class GroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(actor: AuthUser) {
    const rows = await this.prisma.userGroup.findMany({
      where: { organizationId: actor.organizationId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, createdAt: true, _count: { select: { members: true } } },
    });
    return rows.map((g) => ({ id: g.id, name: g.name, memberCount: g._count.members, createdAt: g.createdAt }));
  }

  async get(actor: AuthUser, id: string) {
    const g = await this.findGroup(actor, id);
    const members = await this.prisma.groupMember.findMany({
      where: { groupId: id, organizationId: actor.organizationId },
      orderBy: { user: { name: 'asc' } },
      select: { user: { select: { id: true, name: true, email: true, orgRole: true, status: true } } },
    });
    return { id: g.id, name: g.name, members: members.map((m) => m.user) };
  }

  async create(actor: AuthUser, name: string, meta: RequestMeta) {
    const clean = name.trim();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const g = await tx.userGroup.create({ data: { organizationId: actor.organizationId, name: clean } });
        await this.audit.record({ action: AuditAction.GroupCreated, organizationId: actor.organizationId, actorId: actor.id, entityType: 'user_group', entityId: g.id, metadata: { name: clean }, ...meta }, tx);
        return { id: g.id, name: g.name };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('A group with this name already exists');
      throw e;
    }
  }

  async rename(actor: AuthUser, id: string, name: string, meta: RequestMeta) {
    const g = await this.findGroup(actor, id);
    const clean = name.trim();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.userGroup.update({ where: { id }, data: { name: clean } });
        await this.audit.record({ action: AuditAction.GroupRenamed, organizationId: actor.organizationId, actorId: actor.id, entityType: 'user_group', entityId: id, metadata: { from: g.name, to: clean }, ...meta }, tx);
        return { id: updated.id, name: updated.name };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('A group with this name already exists');
      throw e;
    }
  }

  /**
   * Safe deletion. Refused when it would strand a non-Admin user without any group, or while pending work is routed
   * to it. Membership rows cascade; nothing else is removed.
   */
  async remove(actor: AuthUser, id: string, meta: RequestMeta) {
    const g = await this.findGroup(actor, id);
    const routedRevisions = await this.prisma.kanbanRevision.count({
      where: { organizationId: actor.organizationId, routingGroupIds: { has: id }, state: { in: [...OPEN_KANBAN_STATES] } },
    });
    const routedSops = await this.prisma.sopVersion.count({
      where: { organizationId: actor.organizationId, routingGroupIds: { has: id }, lifecycleState: { in: [...OPEN_SOP_STATES] } },
    });
    if (routedRevisions + routedSops > 0) {
      throw new ConflictException(`This group is the routing scope of ${routedRevisions + routedSops} pending item(s). Resolve them before deleting the group.`);
    }
    const stranded = await this.strandedBy(actor, id);
    if (stranded.length) {
      throw new ConflictException(`${stranded.length} non-Admin user(s) would be left without a group. Move them to another group first.`);
    }
    await this.prisma.$transaction(async (tx) => {
      const memberCount = await tx.groupMember.count({ where: { groupId: id } });
      await tx.userGroup.delete({ where: { id } });
      await this.audit.record({ action: AuditAction.GroupDeleted, organizationId: actor.organizationId, actorId: actor.id, entityType: 'user_group', entityId: id, metadata: { name: g.name, memberCount }, ...meta }, tx);
    });
  }

  async addMembers(actor: AuthUser, id: string, userIds: string[], meta: RequestMeta) {
    await this.findGroup(actor, id);
    const ids = [...new Set(userIds)];
    const users = await this.prisma.user.findMany({ where: { id: { in: ids }, organizationId: actor.organizationId }, select: { id: true, orgRole: true } });
    if (users.length !== ids.length) throw new NotFoundException('One or more users were not found in this organisation');
    const removedCount = await this.prisma.user.count({ where: { id: { in: ids }, status: 'removed' } });
    if (removedCount) throw new BadRequestException('Removed users cannot be added to a group');
    await this.prisma.$transaction(async (tx) => {
      await tx.groupMember.createMany({ data: ids.map((userId) => ({ groupId: id, userId, organizationId: actor.organizationId })), skipDuplicates: true });
      await this.audit.record({ action: AuditAction.GroupMembersAdded, organizationId: actor.organizationId, actorId: actor.id, entityType: 'user_group', entityId: id, metadata: { userIds: ids }, ...meta }, tx);
    });
    return this.get(actor, id);
  }

  /** A non-Admin user keeps at least one group: removing their last membership is refused. */
  async removeMember(actor: AuthUser, id: string, userId: string, meta: RequestMeta) {
    await this.findGroup(actor, id);
    const membership = await this.prisma.groupMember.findFirst({ where: { groupId: id, userId, organizationId: actor.organizationId }, select: { userId: true } });
    if (!membership) throw new NotFoundException('That user is not in this group');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { orgRole: true } });
    if (!isFullAccessRole(user.orgRole)) {
      const others = await this.prisma.groupMember.count({ where: { userId, groupId: { not: id } } });
      if (others === 0) throw new ConflictException('A non-Admin user must keep at least one group. Add them to another group first.');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.groupMember.delete({ where: { groupId_userId: { groupId: id, userId } } });
      await this.audit.record({ action: AuditAction.GroupMemberRemoved, organizationId: actor.organizationId, actorId: actor.id, entityType: 'user_group', entityId: id, metadata: { userId }, ...meta }, tx);
    });
    return this.get(actor, id);
  }

  /** Non-Admin users whose only group is `groupId`. */
  private async strandedBy(actor: AuthUser, groupId: string): Promise<string[]> {
    const members = await this.prisma.groupMember.findMany({
      where: { groupId, organizationId: actor.organizationId, user: { orgRole: { notIn: ['ADMIN', 'OWNER'] } } },
      select: { userId: true },
    });
    if (members.length === 0) return [];
    const others = await this.prisma.groupMember.findMany({
      where: { userId: { in: members.map((m) => m.userId) }, groupId: { not: groupId } },
      select: { userId: true },
    });
    const withOther = new Set(others.map((o) => o.userId));
    return members.map((m) => m.userId).filter((u) => !withOther.has(u));
  }

  private async findGroup(actor: AuthUser, id: string) {
    const g = await this.prisma.userGroup.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!g) throw new NotFoundException('Group not found');
    return g;
  }
}
