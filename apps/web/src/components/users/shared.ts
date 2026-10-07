import type { Role } from '@/lib/api';

/** One person as returned by GET /users (and the first fields of GET /users/:id). */
export interface UserRow {
  id: string;
  name: string;
  email: string;
  status: 'invited' | 'active' | 'suspended' | 'removed';
  orgRole: Role;
  lastLoginAt: string | null;
  createdAt: string;
  mfaEnabled: boolean;
  groups: { id: string; name: string }[];
  /** Permissions granted to this person on top of their role. */
  extraPermissions: string[];
  /** Server-computed approval readiness (same result on the list and the detail). */
  approvalReadiness: { ready: boolean; issue: string | null };
}

/** Colour class for each role's pill, used on every role label and role dropdown. Styles are in globals.css (`.role-pill--*`). */
export const ROLE_PILL_CLASS: Record<Role, string> = {
  ADMIN: 'role-pill--admin',
  EDITOR: 'role-pill--editor',
  OPERATOR: 'role-pill--viewer',
  PRE_APPROVER: 'role-pill--pre-approver',
  APPROVER: 'role-pill--approver',
};

export const STATUS_BADGE:Record<UserRow['status'], string> = {
  active: 'badge-green',
  invited: 'badge-blue',
  suspended: 'badge-amber',
  removed: 'badge-red',
};

export const STATUS_LABEL: Record<UserRow['status'], string> = {
  active: 'Active',
  invited: 'Invited',
  suspended: 'Suspended',
  removed: 'Removed',
};
