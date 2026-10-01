import { OrgRole } from '@prisma/client';

/**
 * Permission catalogue — one entry per row of the §7.2 matrix.
 * Resource-level refinements (e.g. "Trainer: their trainees only",
 * "Editor: own activity only") are enforced in the owning service.
 */
export enum Permission {
  /** Any authenticated, active user (e.g. /me). */
  Authenticated = 'authenticated',
  UsersManage = 'users.manage',
  UsersChangeRole = 'users.change_role',
  OrgSettingsManage = 'org.settings.manage',
  FoldersEdit = 'folders.edit',
  SopEdit = 'sop.edit',
  SopSubmit = 'sop.submit',
  SopApprove = 'sop.approve',
  SopPublish = 'sop.publish',
  SopView = 'sop.view',
  ChecklistComplete = 'checklist.complete',
  KanbanEdit = 'kanban.edit',
  KanbanBulk = 'kanban.bulk',
  SkillsView = 'skills.view',
  SkillsUpdate = 'skills.update',
  TrainerAssign = 'trainer.assign',
  AnalyticsView = 'analytics.view',
  ShareExport = 'share.export',
  OrgDelete = 'org.delete',
  AuditLogView = 'audit.view',
}

/**
 * Three working roles (plus the account Owner):
 *   ADMIN    — everything: users, settings, audit, content, approve & publish
 *   EDITOR   — create, edit, approve & publish SOPs; kanbans, folders, training records
 *   OPERATOR — shown as "Viewer": read-only access to published SOPs and drafts
 * APPROVER and TRAINER are retired (migrated to EDITOR, no longer assignable); any account still holding one
 * only gets the read-only rights every role has.
 */
const { OWNER, ADMIN, EDITOR, OPERATOR } = OrgRole;
const ALL: OrgRole[] = Object.values(OrgRole);
const MANAGERS: OrgRole[] = [OWNER, ADMIN];
const AUTHORS: OrgRole[] = [OWNER, ADMIN, EDITOR];

/** Roles that can be given to a user (invite / role change). OWNER is the account holder and never assigned. */
export const ASSIGNABLE_ROLES: OrgRole[] = [ADMIN, EDITOR, OPERATOR];

export const PERMISSION_MATRIX: Record<Permission, readonly OrgRole[]> = {
  [Permission.Authenticated]: ALL,
  [Permission.UsersManage]: MANAGERS,
  [Permission.UsersChangeRole]: MANAGERS, // Admin may not grant/alter Owner/Admin — service-level check
  [Permission.OrgSettingsManage]: MANAGERS,
  [Permission.FoldersEdit]: AUTHORS,
  [Permission.SopEdit]: AUTHORS,
  [Permission.SopSubmit]: AUTHORS,
  [Permission.SopApprove]: AUTHORS,
  [Permission.SopPublish]: AUTHORS,
  [Permission.SopView]: ALL,
  [Permission.ChecklistComplete]: ALL,
  [Permission.KanbanEdit]: AUTHORS,
  [Permission.KanbanBulk]: AUTHORS,
  [Permission.SkillsView]: [OWNER, ADMIN, EDITOR, OPERATOR], // Viewer: own row only — service-level
  [Permission.SkillsUpdate]: AUTHORS,
  [Permission.TrainerAssign]: MANAGERS,
  [Permission.AnalyticsView]: AUTHORS, // Editor: own activity only — service-level
  [Permission.ShareExport]: ALL,
  [Permission.OrgDelete]: [OWNER],
  [Permission.AuditLogView]: MANAGERS,
};

export function roleHasPermission(role: OrgRole, permission: Permission): boolean {
  return PERMISSION_MATRIX[permission].includes(role);
}
