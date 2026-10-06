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
  /** Server-computed approval readiness (same result on the list and the detail). */
  approvalReadiness: { ready: boolean; issue: string | null };
}

export const STATUS_BADGE: Record<UserRow['status'], string> = {
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
