import { Injectable } from '@nestjs/common';
import { OrgRole } from '@prisma/client';
import { AuditAction, AuditService } from '../audit/audit.service';
import { effectivePermissions, Permission } from '../common/permissions';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';

/** Roles that hold approval work; Admins act through override, not through the pool. */
const WORKING_ROLES: OrgRole[] = ['OPERATOR', 'EDITOR', 'PRE_APPROVER', 'APPROVER'];

export interface PoolMember {
  id: string;
  name: string;
  email: string | null;
  orgRole: OrgRole;
  groupIds: string[];
}

/**
 * Who currently holds an approval permission in the routing scope. Computed from live roles, permissions and group
 * membership, so a pending item becomes actionable as soon as an eligible person appears, and blocked when none exists.
 */
@Injectable()
export class ApprovalPool {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  /** Working-role users who hold `permission` and share a group with `routingGroupIds` (empty routing = all). Excludes `excludeUserId`. */
  async members(organizationId: string, permission: Permission, routingGroupIds: string[], excludeUserId: string | null): Promise<PoolMember[]> {
    const settings = await this.prisma.organizationSettings.findUnique({ where: { organizationId }, select: { rolePermissions: true } });
    const rows = await this.prisma.user.findMany({
      where: { organizationId, status: 'active', orgRole: { in: WORKING_ROLES }, ...(excludeUserId ? { id: { not: excludeUserId } } : {}) },
      select: { id: true, name: true, email: true, orgRole: true, groupMemberships: { select: { groupId: true } } },
    });
    const scope = new Set(routingGroupIds);
    return rows
      .filter((u) => effectivePermissions(u.orgRole, settings?.rolePermissions).has(permission))
      .filter((u) => scope.size === 0 || u.groupMemberships.some((m) => scope.has(m.groupId)))
      .map((u) => ({ id: u.id, name: u.name, email: u.email, orgRole: u.orgRole, groupIds: u.groupMemberships.map((m) => m.groupId) }));
  }

  /** Active Admins with an email address, for blocked-stage alerts. */
  async admins(organizationId: string): Promise<PoolMember[]> {
    const rows = await this.prisma.user.findMany({
      where: { organizationId, status: 'active', orgRole: { in: ['ADMIN'] } },
      select: { id: true, name: true, email: true, orgRole: true },
    });
    return rows.map((u) => ({ ...u, groupIds: [] }));
  }

  /**
   * Sends one mail per recipient. A recipient without an email is never silently dropped: it is audited as
   * notification.skipped against the item, so the omission is visible in the audit trail.
   */
  async notify(
    organizationId: string,
    recipients: PoolMember[],
    item: { entityType: string; entityId: string },
    message: { subject: string; text: string },
  ): Promise<{ sent: number; skipped: number }> {
    let sent = 0;
    let skipped = 0;
    for (const r of recipients) {
      if (!r.email) {
        skipped += 1;
        await this.audit.record({
          action: AuditAction.NotificationSkipped,
          organizationId,
          entityType: item.entityType,
          entityId: item.entityId,
          metadata: { recipientId: r.id, reason: 'no_email', subject: message.subject },
        });
        continue;
      }
      await this.mail.send({ to: r.email, subject: message.subject, text: message.text });
      sent += 1;
    }
    return { sent, skipped };
  }
}
