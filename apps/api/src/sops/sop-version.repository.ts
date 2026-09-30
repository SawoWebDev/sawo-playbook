import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, VersionLifecycleState } from '@prisma/client';
import { Tx } from '../prisma/prisma.service';

export class ImmutableVersionError extends ConflictException {
  constructor(state: VersionLifecycleState) {
    super(
      state === 'PUBLISHED'
        ? 'Published versions are immutable — create a new version to make changes'
        : `Only DRAFT versions can be edited (this version is ${state})`,
    );
  }
}

export interface LockedVersion {
  id: string;
  sopId: string;
  organizationId: string;
  lifecycleState: VersionLifecycleState;
}

export interface StepWrite {
  id?: string;
  order: number;
  title: string | null;
  description: string;
  isTextOnly: boolean;
  isCritical: boolean;
  usesOkNotokMedia: boolean;
  plannedTimeSeconds: number;
  linkedSopId: string | null;
  linkedSopVersionId: string | null;
  mediaAssetIds: string[];
}

/**
 * Repository for version content (§10 layer 2). It independently refuses any
 * content write unless the row-locked version is DRAFT — regardless of what
 * the calling service already checked.
 */
@Injectable()
export class SopVersionRepository {
  /** Row-locks the version (FOR UPDATE) after verifying tenant + parent SOP. */
  async lock(tx: Tx, organizationId: string, sopId: string, versionId: string): Promise<LockedVersion> {
    const rows = await tx.$queryRaw<LockedVersion[]>`
      SELECT id, sop_id AS "sopId", organization_id AS "organizationId", lifecycle_state AS "lifecycleState"
      FROM sop_version
      WHERE id = ${versionId}::uuid AND sop_id = ${sopId}::uuid AND organization_id = ${organizationId}::uuid
      FOR UPDATE`;
    if (!rows[0]) throw new NotFoundException('Version not found');
    return rows[0];
  }

  async lockDraft(tx: Tx, organizationId: string, sopId: string, versionId: string): Promise<LockedVersion> {
    const v = await this.lock(tx, organizationId, sopId, versionId);
    this.assertDraft(v);
    return v;
  }

  assertDraft(v: Pick<LockedVersion, 'lifecycleState'>) {
    if (v.lifecycleState !== 'DRAFT') throw new ImmutableVersionError(v.lifecycleState);
  }

  async updateDraftFields(tx: Tx, v: LockedVersion, data: Prisma.SopVersionUpdateInput) {
    this.assertDraft(await this.currentState(tx, v.id));
    return tx.sopVersion.update({ where: { id: v.id }, data });
  }

  /** Replaces the full ordered step list of a DRAFT version. Returns asset ids before/after. */
  async replaceSteps(tx: Tx, v: LockedVersion, steps: StepWrite[]): Promise<{ before: string[]; after: string[] }> {
    this.assertDraft(await this.currentState(tx, v.id));
    const existing = await tx.sopStep.findMany({
      where: { sopVersionId: v.id },
      select: { id: true, media: { select: { mediaAssetId: true } } },
    });
    const before = existing.flatMap((s) => s.media.map((m) => m.mediaAssetId));
    const existingIds = new Set(existing.map((s) => s.id));

    if (existing.length) {
      await tx.sopStepMedia.deleteMany({ where: { sopStepId: { in: [...existingIds] } } });
      await tx.sopStep.deleteMany({ where: { sopVersionId: v.id } });
    }
    for (const s of steps) {
      const created = await tx.sopStep.create({
        data: {
          // keep a step's id stable across saves when the client sends it back
          id: s.id && existingIds.has(s.id) ? s.id : undefined,
          organizationId: v.organizationId,
          sopVersionId: v.id,
          order: s.order,
          title: s.title,
          description: s.description,
          isTextOnly: s.isTextOnly,
          isCritical: s.isCritical,
          usesOkNotokMedia: s.usesOkNotokMedia,
          plannedTimeSeconds: s.plannedTimeSeconds,
          linkedSopId: s.linkedSopId,
          linkedSopVersionId: s.linkedSopVersionId,
        },
      });
      if (s.mediaAssetIds.length) {
        await tx.sopStepMedia.createMany({
          data: s.mediaAssetIds.map((mediaAssetId, displayOrder) => ({ sopStepId: created.id, mediaAssetId, displayOrder })),
        });
      }
    }
    return { before, after: steps.flatMap((s) => s.mediaAssetIds) };
  }

  private async currentState(tx: Tx, id: string) {
    return tx.sopVersion.findUniqueOrThrow({ where: { id }, select: { lifecycleState: true } });
  }
}
