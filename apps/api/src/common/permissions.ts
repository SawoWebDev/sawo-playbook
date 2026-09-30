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

const { OWNER, ADMIN, EDITOR, APPROVER, TRAINER, OPERATOR } = OrgRole;
const ALL: OrgRole[] = [OWNER, ADMIN, EDITOR, APPROVER, TRAINER, OPERATOR];

export const PERMISSION_MATRIX: Record<Permission, readonly OrgRole[]> = {
  [Permission.Authenticated]: ALL,
  [Permission.UsersManage]: [OWNER, ADMIN],
  [Permission.UsersChangeRole]: [OWNER, ADMIN], // Admin may not grant/alter Owner/Admin — service-level check
  [Permission.OrgSettingsManage]: [OWNER, ADMIN],
  [Permission.FoldersEdit]: [OWNER, ADMIN, EDITOR],
  [Permission.SopEdit]: [OWNER, ADMIN, EDITOR],
  [Permission.SopSubmit]: [OWNER, ADMIN, EDITOR],
  [Permission.SopApprove]: [OWNER, ADMIN, APPROVER],
  [Permission.SopPublish]: [OWNER, ADMIN, APPROVER],
  [Permission.SopView]: ALL,
  [Permission.ChecklistComplete]: ALL,
  [Permission.KanbanEdit]: [OWNER, ADMIN, EDITOR],
  [Permission.KanbanBulk]: [OWNER, ADMIN, EDITOR],
  [Permission.SkillsView]: [OWNER, ADMIN, TRAINER, OPERATOR], // Operator: own row only — service-level
  [Permission.SkillsUpdate]: [OWNER, ADMIN, TRAINER], // Trainer: their trainees only — service-level
  [Permission.TrainerAssign]: [OWNER, ADMIN],
  [Permission.AnalyticsView]: [OWNER, ADMIN, EDITOR], // Editor: own activity only — service-level
  [Permission.ShareExport]: ALL,
  [Permission.OrgDelete]: [OWNER],
  [Permission.AuditLogView]: [OWNER, ADMIN],
};

export function roleHasPermission(role: OrgRole, permission: Permission): boolean {
  return PERMISSION_MATRIX[permission].includes(role);
}
