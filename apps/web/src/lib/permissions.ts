import type { Role } from './api';

/**
 * UI-only mirror of the §7.2 matrix, used to hide controls. The API's
 * AuthorizationGuard is the authority — never rely on this for security.
 */
const ALL: Role[] = ['OWNER', 'ADMIN', 'EDITOR', 'APPROVER', 'TRAINER', 'OPERATOR'];
/** Admin (and the account Owner): everything. Editor: create, edit, approve & publish. Viewer (OPERATOR): read-only. */
const MANAGERS: Role[] = ['OWNER', 'ADMIN'];
const AUTHORS: Role[] = ['OWNER', 'ADMIN', 'EDITOR'];

export const can = {
  manageUsers: MANAGERS,
  manageSettings: MANAGERS,
  editFolders: AUTHORS,
  editSops: AUTHORS,
  approveSops: AUTHORS,
  publishSops: AUTHORS,
  viewSops: ALL,
  editKanbans: AUTHORS,
  viewSkills: ['OWNER', 'ADMIN', 'EDITOR', 'OPERATOR'],
  updateSkills: AUTHORS,
  viewAnalytics: AUTHORS,
  viewAudit: MANAGERS,
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
  APPROVER: 'Approver (retired)',
  TRAINER: 'Trainer (retired)',
  OPERATOR: 'Viewer',
};

/** Roles that can be given to users. */
export const ASSIGNABLE_ROLES: Role[] = ['ADMIN', 'EDITOR', 'OPERATOR'];

/** What each role can do — shown next to the role pickers. */
export const ROLE_SUMMARY: Partial<Record<Role, string>> = {
  OWNER: 'Account holder: everything an Admin can do, plus deleting the organization.',
  ADMIN: 'Full access: users, settings, audit log, SOPs, kanbans, folders, training — and approves / publishes.',
  EDITOR: 'Creates and edits SOPs, kanbans and folders, approves and publishes them, and records training.',
  OPERATOR: 'Read-only: views published SOPs and drafts, kanbans and their own training. Cannot change anything.',
};
