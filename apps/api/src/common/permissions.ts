import { OrgRole } from '@prisma/client';

/**
 * Permission catalogue. Values are stored in organization_settings.role_permissions, so they are stable identifiers.
 * Only the five working roles exist: ADMIN, OPERATOR (shown as "Viewer"), EDITOR, PRE_APPROVER, APPROVER.
 */
export enum Permission {
  /** Any authenticated, active user (e.g. /me). Always granted, never configurable. */
  Authenticated = 'authenticated',

  // ── Admin-only system permissions (never configurable for other roles) ──
  UsersManage = 'users.manage',
  UsersChangeRole = 'users.change_role',
  /** Assign trainers to associates (admin-managed; not a delegable skills permission). */
  TrainerAssign = 'trainer.assign',
  GroupsManage = 'groups.manage',
  RolesManage = 'roles.manage',
  OrgSettingsManage = 'org.settings.manage',
  OrgDelete = 'organization.delete',
  AuditLogView = 'audit.view',

  // ── Kanbans ──
  KanbanView = 'kanban.view',
  KanbanCreate = 'kanban.create',
  KanbanEdit = 'kanban.edit',
  KanbanDelete = 'kanban.delete',
  KanbanSubmit = 'kanban.submit',
  KanbanReview = 'kanban.review',
  KanbanPreApprove = 'kanban.preapprove',
  KanbanApprove = 'kanban.approve',
  KanbanPublish = 'kanban.publish',
  /** Direct CSV import / bulk edit — bypasses the revision workflow, so granted to publishers only by default. */
  KanbanBulk = 'kanban.bulk',

  // ── STD OPS (SOPs) ──
  SopView = 'sop.view',
  SopCreate = 'sop.create',
  SopEdit = 'sop.edit',
  SopDelete = 'sop.delete',
  SopSubmit = 'sop.submit',
  SopReview = 'sop.review',
  SopPreApprove = 'sop.preapprove',
  SopApprove = 'sop.approve',
  SopPublish = 'sop.publish',

  // ── Other areas ──
  FoldersEdit = 'folders.edit',
  ChecklistComplete = 'checklist.complete',
  /** See every checklist submission in the organisation (otherwise only your own). */
  ChecklistViewAll = 'checklist.view_all',
  SkillsView = 'skills.view',
  SkillsUpdate = 'skills.update',
  AnalyticsView = 'analytics.view',
  /** See organisation-wide analytics (otherwise only your own activity). */
  AnalyticsViewAll = 'analytics.view_all',
  ShareExport = 'share.export',
}

/** Permissions only Admin may hold; they are never offered in the role matrix for other roles. */
export const ADMIN_ONLY_PERMISSIONS: readonly Permission[] = [
  Permission.UsersManage,
  Permission.UsersChangeRole,
  Permission.TrainerAssign,
  Permission.GroupsManage,
  Permission.RolesManage,
  Permission.OrgSettingsManage,
  Permission.OrgDelete,
  Permission.AuditLogView,
];

/** Everything an admin can grant to the non-Admin roles. */
export const CONFIGURABLE_PERMISSIONS: readonly Permission[] = Object.values(Permission).filter(
  (p) => p !== Permission.Authenticated && !ADMIN_ONLY_PERMISSIONS.includes(p),
);

const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permission);

/** The five roles an admin can assign. Legacy OWNER is treated as ADMIN in code; TRAINER has no permissions. */
export const ASSIGNABLE_ROLES: OrgRole[] = ['ADMIN', 'OPERATOR', 'EDITOR', 'PRE_APPROVER', 'APPROVER'];

export const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Admin',
  OPERATOR: 'Viewer',
  EDITOR: 'Editor',
  PRE_APPROVER: 'Pre Approver',
  APPROVER: 'Approver',
};

/** Default configuration, applied until an admin changes a role. Admin is always full and cannot be edited. */
export const DEFAULT_ROLE_PERMISSIONS: Record<'OPERATOR' | 'EDITOR' | 'PRE_APPROVER' | 'APPROVER', readonly Permission[]> = {
  OPERATOR: [
    Permission.KanbanView,
    Permission.SopView,
    Permission.ChecklistComplete,
    Permission.ShareExport,
    Permission.SkillsView,
  ],
  EDITOR: [
    Permission.KanbanView,
    Permission.KanbanCreate,
    Permission.KanbanEdit,
    Permission.KanbanSubmit,
    Permission.SopView,
    Permission.SopCreate,
    Permission.SopEdit,
    Permission.SopSubmit,
    Permission.FoldersEdit,
    Permission.ChecklistComplete,
    Permission.ChecklistViewAll,
    Permission.ShareExport,
    Permission.SkillsView,
    Permission.SkillsUpdate,
    Permission.AnalyticsView,
  ],
  PRE_APPROVER: [
    Permission.KanbanView,
    Permission.KanbanReview,
    Permission.KanbanPreApprove,
    Permission.SopView,
    Permission.SopReview,
    Permission.SopPreApprove,
    Permission.ChecklistComplete,
    Permission.ShareExport,
    Permission.SkillsView,
  ],
  APPROVER: [
    Permission.KanbanView,
    Permission.KanbanCreate,
    Permission.KanbanEdit,
    Permission.KanbanDelete,
    Permission.KanbanReview,
    Permission.KanbanApprove,
    Permission.KanbanPublish,
    Permission.KanbanBulk,
    Permission.SopView,
    Permission.SopCreate,
    Permission.SopEdit,
    Permission.SopDelete,
    Permission.SopReview,
    Permission.SopApprove,
    Permission.SopPublish,
    Permission.ChecklistComplete,
    Permission.ShareExport,
    Permission.SkillsView,
  ],
};

/** Roles whose permissions are fixed (cannot be edited) and always hold every permission. */
export function isFullAccessRole(role: OrgRole): boolean {
  return role === 'ADMIN' || role === 'OWNER';
}

/** Effective permissions for a role given the organisation's stored overrides. Pure, so it is unit-testable. */
export function effectivePermissions(role: OrgRole, stored: unknown): Set<Permission> {
  if (isFullAccessRole(role)) return new Set(ALL_PERMISSIONS);
  if (role === 'TRAINER') return new Set([Permission.Authenticated]);
  const known = new Set<string>(ALL_PERMISSIONS);
  const configured = stored && typeof stored === 'object' ? (stored as Record<string, unknown>)[role] : undefined;
  const list: string[] = Array.isArray(configured)
    ? configured.filter((p): p is string => typeof p === 'string')
    : [...DEFAULT_ROLE_PERMISSIONS[role as keyof typeof DEFAULT_ROLE_PERMISSIONS]];
  const granted = new Set<Permission>([Permission.Authenticated]);
  for (const p of list) {
    if (known.has(p) && !ADMIN_ONLY_PERMISSIONS.includes(p as Permission)) granted.add(p as Permission);
  }
  return granted;
}

/**
 * What one person may do: their role's permissions plus any extra permissions an Admin granted to them. Extras that are
 * not configurable (Admin-only or unknown) are ignored, so they can never be granted this way.
 */
export function userPermissions(role: OrgRole, stored: unknown, extra: readonly string[]): Set<Permission> {
  const granted = effectivePermissions(role, stored);
  if (isFullAccessRole(role)) return granted;
  const configurable = new Set<string>(CONFIGURABLE_PERMISSIONS);
  for (const p of extra) if (configurable.has(p)) granted.add(p as Permission);
  return granted;
}

/** Sync check against the actor's already-loaded permission set (populated by AuthorizationGuard). */
export function hasPermission(actor: { permissions: ReadonlySet<Permission> }, permission: Permission): boolean {
  return actor.permissions.has(permission);
}
