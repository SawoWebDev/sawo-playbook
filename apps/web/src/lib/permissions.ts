import type { Role } from './api';

/**
 * UI-only mirror of the §7.2 matrix, used to hide controls. The API's
 * AuthorizationGuard is the authority — never rely on this for security.
 */
const ALL: Role[] = ['OWNER', 'ADMIN', 'EDITOR', 'APPROVER', 'TRAINER', 'OPERATOR'];

export const can = {
  manageUsers: ['OWNER', 'ADMIN'],
  manageSettings: ['OWNER', 'ADMIN'],
  editFolders: ['OWNER', 'ADMIN', 'EDITOR'],
  editSops: ['OWNER', 'ADMIN', 'EDITOR'],
  approveSops: ['OWNER', 'ADMIN', 'APPROVER'],
  publishSops: ['OWNER', 'ADMIN', 'APPROVER'],
  viewSops: ALL,
  editKanbans: ['OWNER', 'ADMIN', 'EDITOR'],
  viewSkills: ['OWNER', 'ADMIN', 'TRAINER', 'OPERATOR'],
  updateSkills: ['OWNER', 'ADMIN', 'TRAINER'],
  viewAnalytics: ['OWNER', 'ADMIN', 'EDITOR'],
  viewAudit: ['OWNER', 'ADMIN'],
  deleteOrg: ['OWNER'],
} satisfies Record<string, Role[]>;

export type Capability = keyof typeof can;

export function allowed(role: Role | undefined, cap: Capability): boolean {
  return !!role && (can[cap] as Role[]).includes(role);
}

export const ROLE_LABELS: Record<Role, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  EDITOR: 'Editor',
  APPROVER: 'Approver',
  TRAINER: 'Trainer',
  OPERATOR: 'Operator / Viewer',
};
