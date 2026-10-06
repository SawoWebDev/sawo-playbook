import { useAuth } from './auth';
import type { Role, SessionUser } from './api';

/**
 * Permission helpers for the UI. Visibility and enabled state come from the server's effective permissions
 * (GET /auth/me). Nothing here maps a role name to a capability: the backend decides, and the API still enforces
 * every request.
 */

/** Labels for the five assignable roles. OPERATOR is the wire value of the Viewer role. */
export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Admin',
  OPERATOR: 'Viewer',
  EDITOR: 'Editor',
  PRE_APPROVER: 'Pre Approver',
  APPROVER: 'Approver',
};

/** The roles that can be given to a person, in display order. */
export const ASSIGNABLE_ROLES: Role[] = ['ADMIN', 'OPERATOR', 'EDITOR', 'PRE_APPROVER', 'APPROVER'];

/** Label for any role value from the API. Legacy values fall back to their raw name rather than a guessed label. */
export function roleLabel(role: string | null | undefined): string {
  if (!role) return '';
  return ROLE_LABELS[role as Role] ?? role;
}

/** Whether the signed-in user holds a permission, per the server's effective permission list. */
export function hasPermission(user: Pick<SessionUser, 'permissions'> | null | undefined, permission: string): boolean {
  return !!user?.permissions.includes(permission);
}

/** Hook form: `const { can } = usePermissions();` then `can('kanban.publish')`. */
export function usePermissions() {
  const { user } = useAuth();
  return { user, can: (permission: string) => hasPermission(user, permission) };
}
