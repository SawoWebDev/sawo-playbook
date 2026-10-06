import { isFullAccessRole, Permission } from '../common/permissions';
import { AuthUser } from '../common/auth-user';

/**
 * Approval eligibility (pure). Evaluated at the moment an actor acts, against their CURRENT permissions and groups.
 * The routing snapshot on a revision is scope, never proof of authority.
 *
 * Rules:
 *  1. The actor must hold the permission for the action.
 *  2. Admins are unrestricted by group scope.
 *  3. Everyone else must share at least one group with the routing snapshot.
 *     An empty snapshot (content submitted by an Admin) is organisation-wide.
 *  4. The submitter may not pre-approve or approve their own revision unless the organisation allows self-approval.
 *     Publishing is not blocked by this rule: publishers may publish directly.
 */
export type EligibilityDenial = 'missing_permission' | 'outside_routing_group' | 'self_approval' | null;

export function eligibility(
  actor: Pick<AuthUser, 'id' | 'role' | 'groupIds' | 'permissions'>,
  input: { routingGroupIds: string[]; submittedById: string | null; permission: Permission; allowSelfApproval: boolean; isPublish: boolean },
): EligibilityDenial {
  if (!actor.permissions.has(input.permission)) return 'missing_permission';
  if (!input.isPublish && input.submittedById === actor.id && !input.allowSelfApproval) return 'self_approval';
  if (isFullAccessRole(actor.role)) return null;
  if (input.routingGroupIds.length === 0) return null;
  const mine = new Set(actor.groupIds);
  return input.routingGroupIds.some((g) => mine.has(g)) ? null : 'outside_routing_group';
}

export const DENIAL_MESSAGES: Record<Exclude<EligibilityDenial, null>, string> = {
  missing_permission: 'Your role does not allow this action',
  outside_routing_group: 'This item is routed to a different group; you are not an eligible approver for it',
  self_approval: 'You cannot approve or pre-approve your own submission',
};
