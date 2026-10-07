import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, Tx } from '../prisma/prisma.service';

/** Minimum event set per §7.6. Keep names stable: they are compliance records. */
export const AuditAction = {
  LoginSuccess: 'auth.login.success',
  LoginFailure: 'auth.login.failure',
  LoginLocked: 'auth.login.locked',
  RefreshReuseDetected: 'auth.refresh.reuse_detected',
  Logout: 'auth.logout',
  PasswordReset: 'auth.password.reset',
  MfaChanged: 'auth.mfa.changed',
  OrgCreated: 'org.created',
  OrgSettingsChanged: 'org.settings.changed',
  OrgDeletionRequested: 'org.deletion.requested',
  OrgDeletionCancelled: 'org.deletion.cancelled',
  OrgDeletionConfirmed: 'org.deletion.confirmed',
  UserCreated: 'user.created',
  UserInvited: 'user.invited',
  UserInviteAccepted: 'user.invite.accepted',
  UserInviteRevoked: 'user.invite.revoked',
  UserRoleChanged: 'user.role.changed',
  UserPermissionsChanged: 'user.permissions.changed',
  UserSuspended: 'user.suspended',
  UserReactivated: 'user.reactivated',
  UserRemoved: 'user.removed',
  SopVersionSubmitted: 'sop.version.submitted',
  SopVersionApproved: 'sop.version.approved',
  SopVersionRejected: 'sop.version.rejected',
  SopArchived: 'sop.archived',
  KanbanRevisionCreated: 'kanban.revision.created',
  KanbanRevisionUpdated: 'kanban.revision.updated',
  KanbanRevisionSubmitted: 'kanban.revision.submitted',
  KanbanRevisionPreApproved: 'kanban.revision.pre_approved',
  KanbanRevisionApproved: 'kanban.revision.approved',
  KanbanRevisionRejected: 'kanban.revision.rejected',
  KanbanRevisionPublished: 'kanban.revision.published',
  KanbanRevisionDiscarded: 'kanban.revision.discarded',
  KanbanRevisionBlocked: 'kanban.revision.blocked',
  KanbanRevisionDenied: 'kanban.revision.authorization_denied',
  KanbanDeleted: 'kanban.deleted',
  NotificationSkipped: 'notification.skipped',
  GroupCreated: 'group.created',
  GroupRenamed: 'group.renamed',
  GroupDeleted: 'group.deleted',
  GroupMembersAdded: 'group.members.added',
  GroupMemberRemoved: 'group.member.removed',
  RolePermissionsChanged: 'role.permissions.changed',
  UserUpdated: 'user.updated',
  SopVersionPublished: 'sop.version.published',
  SopVersionPreApproved: 'sop.version.pre_approved',
  SopVersionBlocked: 'sop.version.blocked',
  SopVersionPreApprovalSkipped: 'sop.version.pre_approval_skipped',
  SopVersionDenied: 'sop.version.authorization_denied',
  KanbanBulkImport: 'kanban.bulk.import',
  KanbanBulkEdit: 'kanban.bulk.edit',
  SkillAssessed: 'skills.assessed',
  BackupExported: 'backup.exported',
  BackupRestored: 'backup.restored',
} as const;
export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntry {
  action: AuditActionName;
  organizationId?: string | null;
  actorId?: string | null;
  entityType?: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Pass `tx` to write the audit record atomically with the change it describes. */
  async record(entry: AuditEntry, tx?: Tx): Promise<void> {
    const client = tx ?? this.prisma;
    await client.auditLog.create({
      data: {
        action: entry.action,
        organizationId: entry.organizationId ?? null,
        actorId: entry.actorId ?? null,
        entityType: entry.entityType,
        entityId: entry.entityId,
        metadata: entry.metadata ?? {},
        ip: entry.ip,
        userAgent: entry.userAgent,
      },
    });
  }
}
