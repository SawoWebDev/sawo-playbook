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
}

export interface AccessTokenPayload {
  sub: string;
  org: string;
  role: OrgRole;
  /** User.tokenVersion at issuance; mismatch ⇒ token revoked. */
  tv: number;
}
