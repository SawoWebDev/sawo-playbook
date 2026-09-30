import { MediaLifecycleState } from '@prisma/client';
import { Tx } from '../prisma/prisma.service';

/**
 * §6.6 MediaAsset lifecycle — the full transition graph. Every state change
 * goes through `transitionMedia` so an illegal edge can never be written.
 */
export const MEDIA_TRANSITIONS: Record<MediaLifecycleState, readonly MediaLifecycleState[]> = {
  uploaded: ['attached'],
  attached: ['referenced', 'orphaned'],
  referenced: ['orphaned'],
  orphaned: ['attached', 'soft_deleted'],
  soft_deleted: ['purged'],
  purged: [],
};

export function canTransitionMedia(from: MediaLifecycleState, to: MediaLifecycleState): boolean {
  return MEDIA_TRANSITIONS[from].includes(to);
}

export class IllegalMediaTransitionError extends Error {
  constructor(id: string, from: MediaLifecycleState, to: MediaLifecycleState) {
    super(`MediaAsset ${id}: illegal lifecycle transition ${from} → ${to}`);
  }
}

export async function transitionMedia(tx: Tx, id: string, to: MediaLifecycleState): Promise<void> {
  const asset = await tx.mediaAsset.findUniqueOrThrow({ where: { id }, select: { lifecycleState: true } });
  if (asset.lifecycleState === to) return;
  if (!canTransitionMedia(asset.lifecycleState, to)) throw new IllegalMediaTransitionError(id, asset.lifecycleState, to);
  await tx.mediaAsset.update({
    where: { id },
    data: {
      lifecycleState: to,
      orphanedAt: to === 'orphaned' ? new Date() : to === 'attached' ? null : undefined,
      deletedAt: to === 'soft_deleted' ? new Date() : undefined,
    },
  });
}

/** Number of live references to an asset across every referencing table (§6.6a — join queries, no array scans). */
export async function countMediaReferences(tx: Tx, id: string): Promise<{ total: number; published: number }> {
  const [row] = await tx.$queryRaw<{ total: bigint; published: bigint }[]>`
    SELECT
      (SELECT COUNT(*) FROM sop_step_media sm
         JOIN sop_step s ON s.id = sm.sop_step_id
         JOIN sop_version v ON v.id = s.sop_version_id
        WHERE sm.media_asset_id = ${id}::uuid AND v.lifecycle_state <> 'ABANDONED')
      + (SELECT COUNT(*) FROM kanban_media km JOIN kanban k ON k.id = km.kanban_id WHERE km.media_asset_id = ${id}::uuid AND k.deleted_at IS NULL)
      + (SELECT COUNT(*) FROM kanban WHERE picture_asset_id = ${id}::uuid AND deleted_at IS NULL)
      + (SELECT COUNT(*) FROM sop_version WHERE pdf_asset_id = ${id}::uuid)
      + (SELECT COUNT(*) FROM checklist_response WHERE media_asset_id = ${id}::uuid) AS total,
      (SELECT COUNT(*) FROM sop_step_media sm
         JOIN sop_step s ON s.id = sm.sop_step_id
         JOIN sop_version v ON v.id = s.sop_version_id
        WHERE sm.media_asset_id = ${id}::uuid AND v.lifecycle_state = 'PUBLISHED')
      + (SELECT COUNT(*) FROM sop_version WHERE pdf_asset_id = ${id}::uuid AND lifecycle_state = 'PUBLISHED')
      + (SELECT COUNT(*) FROM checklist_response WHERE media_asset_id = ${id}::uuid) AS published`;
  return { total: Number(row.total), published: Number(row.published) };
}

/** A draft/kanban now points at these assets: uploaded|orphaned → attached. */
export async function markAttached(tx: Tx, ids: Iterable<string>): Promise<void> {
  for (const id of new Set(ids)) {
    const a = await tx.mediaAsset.findUniqueOrThrow({ where: { id }, select: { lifecycleState: true } });
    if (a.lifecycleState === 'uploaded' || a.lifecycleState === 'orphaned') await transitionMedia(tx, id, 'attached');
  }
}

/** A version was published: its assets become durably referenced (Invariant #12). */
export async function markReferenced(tx: Tx, ids: Iterable<string>): Promise<void> {
  for (const id of new Set(ids)) {
    const a = await tx.mediaAsset.findUniqueOrThrow({ where: { id }, select: { lifecycleState: true } });
    if (a.lifecycleState === 'uploaded') await transitionMedia(tx, id, 'attached');
    if (a.lifecycleState !== 'referenced') await transitionMedia(tx, id, 'referenced');
  }
}

/**
 * Re-evaluates assets after references were removed/superseded (draft edit,
 * draft abandoned, kanban deleted, or a published version purged — §6.6).
 * An asset with no remaining reference becomes orphaned; an asset still
 * referenced by a published version is (or stays) referenced.
 */
export async function reevaluateMedia(tx: Tx, ids: Iterable<string>): Promise<void> {
  for (const id of new Set(ids)) {
    const a = await tx.mediaAsset.findUniqueOrThrow({ where: { id }, select: { lifecycleState: true } });
    if (!['attached', 'referenced'].includes(a.lifecycleState)) continue;
    const refs = await countMediaReferences(tx, id);
    if (refs.total === 0) await transitionMedia(tx, id, 'orphaned');
    else if (refs.published > 0 && a.lifecycleState === 'attached') await transitionMedia(tx, id, 'referenced');
  }
}
