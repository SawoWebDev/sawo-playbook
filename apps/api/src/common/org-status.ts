import { OrganizationStatus } from '@prisma/client';

/** Orgs in their deletion cooldown stay usable so the Owner can cancel (§7.7). */
export function orgIsUsable(status: OrganizationStatus): boolean {
  return status === 'active' || status === 'pending_deletion';
}
