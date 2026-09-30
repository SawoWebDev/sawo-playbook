import { SopStatus, VersionLifecycleState } from '@prisma/client';
import { Tx } from '../prisma/prisma.service';

export const ACTIVE_UNPUBLISHED: VersionLifecycleState[] = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'];

/** §6.2 precedence rule — pure function so it can be unit-tested exhaustively. */
export function deriveSopStatus(input: {
  archived: boolean;
  activeState: VersionLifecycleState | null;
  hasPublished: boolean;
}): SopStatus {
  if (input.archived) return 'archived';
  if (input.activeState === 'PENDING_APPROVAL') return 'pending_approval';
  if (input.activeState === 'APPROVED') return 'approved';
  if (input.activeState === 'DRAFT') return 'draft';
  if (input.hasPublished) return 'published';
  return 'draft';
}

/**
 * Invariant #18: SOP.status (and latest_draft_version_id) are derived and
 * written ONLY here, inside the same transaction that changed a version.
 */
export async function recomputeSopStatus(tx: Tx, sopId: string): Promise<SopStatus> {
  const sop = await tx.sop.findUniqueOrThrow({
    where: { id: sopId },
    select: { archivedAt: true, currentPublishedVersionId: true },
  });
  const active = await tx.sopVersion.findFirst({
    where: { sopId, lifecycleState: { in: ACTIVE_UNPUBLISHED } },
    select: { id: true, lifecycleState: true },
  });
  const status = deriveSopStatus({
    archived: !!sop.archivedAt,
    activeState: active?.lifecycleState ?? null,
    hasPublished: !!sop.currentPublishedVersionId,
  });
  await tx.sop.update({ where: { id: sopId }, data: { status, latestDraftVersionId: active?.id ?? null } });
  return status;
}

export function versionLabel(sequence: number): string {
  return `1.${String(sequence).padStart(3, '0')}`;
}
