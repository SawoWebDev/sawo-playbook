import { OrgRole } from '@prisma/client';
import { Permission } from './permissions';

/**
 * The authenticated principal. Always built server-side from the verified JWT
 * and a fresh DB read — never from client-provided fields (Invariants #2, #15).
 * `permissions` and `groupIds` are loaded by AuthorizationGuard on every request.
 */
export interface AuthUser {
  id: string;
  organizationId: string;
  role: OrgRole;
  email: string;
  name: string;
  permissions: ReadonlySet<Permission>;
  groupIds: string[];
  /** True until the user sets their own password after an Admin created the account. */
  passwordMustChange: boolean;
  /** Set when an Admin is signed in as this user via "Impersonate". The Admin's id and name; absent otherwise. */
  impersonatedBy?: { id: string; name: string };
}

export interface AccessTokenPayload {
  sub: string;
  org: string;
  role: OrgRole;
  /** User.tokenVersion at issuance; mismatch ⇒ token revoked. */
  tv: number;
  /** Id of the Admin who started an impersonation session. Only present on impersonation tokens. */
  imp?: string;
}
