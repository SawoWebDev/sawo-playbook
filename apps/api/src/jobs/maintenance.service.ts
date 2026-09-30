import { Injectable, Logger } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service';
import { TokenService } from '../auth/token.service';
import { countMediaReferences, transitionMedia } from '../media/media-lifecycle';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

const DAY = 86_400_000;
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

/**
 * Retention windows (§13, §18 — exact durations are a deferred business decision;
 * these are the documented working assumptions and are env-configurable).
 */
export const retention = {
  /** Soft-deleted tenant data is purged this long after the org deletion is confirmed. */
  get tenantPurgeDays() {
    return num('TENANT_PURGE_RETENTION_DAYS', 30);
  },
  /** AuditLog compliance window (working assumption 3–7 years → 7). */
  get auditDays() {
    return num('AUDIT_RETENTION_DAYS', 7 * 365);
  },
  /** Orphaned media grace period before soft deletion. */
  get mediaOrphanGraceDays() {
    return num('MEDIA_ORPHAN_GRACE_DAYS', 7);
  },
  /** Soft-deleted media retention before physical purge. */
  get mediaSoftDeleteDays() {
    return num('MEDIA_SOFT_DELETE_RETENTION_DAYS', 30);
  },
};

/** Runs inside a transaction that is allowed to delete immutable/append-only rows (documented purge workflow). */
async function allowPurge(tx: Tx) {
  await tx.$executeRaw`SELECT set_config('gemba.allow_purge', 'on', true)`;
}

/**
 * The documented purge workflow (§7.7, §13). Every method takes `now` so the
 * schedule can be exercised deterministically in tests.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger('Maintenance');

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  async runAll(now = new Date()) {
    const finalized = await this.finalizeOrgDeletions(now);
    const purged = await this.purgeDeletedOrgs(now);
    const audits = await this.purgeExpiredCompliance(now);
    const media = await this.cleanupMedia(now);
    return { finalized, purged, audits, media };
  }

  /** Cooldown elapsed → soft-delete: org.status=deleted, children flagged, users blocked. */
  async finalizeOrgDeletions(now: Date): Promise<number> {
    const due = await this.prisma.organization.findMany({
      where: { status: 'pending_deletion', deletionScheduledFor: { lte: now } },
      select: { id: true },
    });
    for (const { id } of due) {
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.organization.updateMany({ where: { id, status: 'pending_deletion' }, data: { status: 'deleted' } });
        if (!claimed.count) return;
        await tx.sop.updateMany({ where: { organizationId: id, deletedAt: null }, data: { deletedAt: now } });
        await tx.kanban.updateMany({ where: { organizationId: id, deletedAt: null }, data: { deletedAt: now } });
        await tx.folder.updateMany({ where: { organizationId: id, deletedAt: null }, data: { deletedAt: now } });
        const users = await tx.user.findMany({ where: { organizationId: id, status: { not: 'removed' } }, select: { id: true } });
        await tx.user.updateMany({ where: { organizationId: id }, data: { status: 'removed' } });
        for (const u of users) await this.tokens.revokeAllForUser(u.id, 'org_deleted', tx);
        await tx.invitation.updateMany({ where: { organizationId: id, status: 'pending' }, data: { status: 'revoked' } });
        await this.audit.record({ action: AuditAction.OrgDeletionConfirmed, organizationId: id, entityType: 'organization', entityId: id }, tx);
      });
      this.logger.log(`Organization ${id} soft-deleted after cooldown`);
    }
    return due.length;
  }

  /**
   * Standard retention elapsed → purge all tenant data EXCEPT records under an
   * active compliance retention requirement (AuditLog), which keep the
   * organization row as a tombstone until `purgeExpiredCompliance`.
   */
  async purgeDeletedOrgs(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - retention.tenantPurgeDays * DAY);
    const due = await this.prisma.organization.findMany({
      where: { status: 'deleted', deletionScheduledFor: { lte: cutoff }, settings: { isNot: null } },
      select: { id: true },
    });
    for (const { id } of due) {
      const keys = await this.prisma.mediaAsset.findMany({ where: { organizationId: id, lifecycleState: { not: 'purged' } }, select: { storageKey: true } });
      await this.prisma.$transaction(
        async (tx) => {
          await allowPurge(tx);
          const org = { organizationId: id };
          await tx.checklistResponse.deleteMany({ where: { submission: org } });
          await tx.checklistSubmission.deleteMany({ where: org });
          await tx.skillRecord.deleteMany({ where: org });
          await tx.skillAssessment.deleteMany({ where: org });
          await tx.trainerAssignment.deleteMany({ where: org });
          await tx.sopVersionApproval.deleteMany({ where: org });
          await tx.sopStepMedia.deleteMany({ where: { sopStep: org } });
          await tx.kanbanMedia.deleteMany({ where: { kanban: org } });
          await tx.kanban.deleteMany({ where: org });
          await tx.sopStep.deleteMany({ where: org });
          await tx.sop.updateMany({ where: org, data: { currentPublishedVersionId: null, latestDraftVersionId: null, folderId: null } });
          await tx.sopVersion.deleteMany({ where: org });
          await tx.sop.deleteMany({ where: org });
          await tx.folder.updateMany({ where: org, data: { parentId: null } });
          await tx.folder.deleteMany({ where: org });
          await tx.mediaAsset.deleteMany({ where: org });
          await tx.activityEvent.deleteMany({ where: org });
          await tx.invitation.deleteMany({ where: org });
          await tx.refreshToken.deleteMany({ where: { user: org } });
          await tx.passwordResetToken.deleteMany({ where: { user: org } });
          await tx.user.updateMany({ where: org, data: { createdById: null } });
          await tx.user.deleteMany({ where: org });
          await tx.organizationSettings.deleteMany({ where: org });
          // AuditLog rows and the organization tombstone are intentionally retained (compliance carve-out).
        },
        { timeout: 120_000 },
      );
      for (const { storageKey } of keys) await this.storage.delete(storageKey).catch(() => undefined);
      this.logger.log(`Organization ${id} tenant data purged; audit records retained`);
    }
    return due.length;
  }

  /** Compliance window elapsed for a purged org → delete its audit records and tombstone. */
  async purgeExpiredCompliance(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - retention.auditDays * DAY);
    const due = await this.prisma.organization.findMany({
      where: { status: 'deleted', deletionScheduledFor: { lte: cutoff }, settings: { is: null } },
      select: { id: true },
    });
    for (const { id } of due) {
      await this.prisma.$transaction(async (tx) => {
        await allowPurge(tx);
        await tx.auditLog.deleteMany({ where: { organizationId: id } });
        await tx.organization.delete({ where: { id } });
      });
    }
    return due.length;
  }

  /** §6.6: orphaned → soft_deleted (after grace, if still unreferenced) → purged (object deleted). */
  async cleanupMedia(now: Date): Promise<{ softDeleted: number; purged: number }> {
    const graceCutoff = new Date(now.getTime() - retention.mediaOrphanGraceDays * DAY);
    const purgeCutoff = new Date(now.getTime() - retention.mediaSoftDeleteDays * DAY);
    let softDeleted = 0;
    let purged = 0;

    const orphans = await this.prisma.mediaAsset.findMany({
      where: { lifecycleState: 'orphaned', orphanedAt: { lte: graceCutoff } },
      select: { id: true },
      take: 1000,
    });
    for (const { id } of orphans) {
      const done = await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ lifecycle_state: string }[]>`SELECT lifecycle_state FROM media_asset WHERE id = ${id}::uuid FOR UPDATE`;
        if (locked[0]?.lifecycle_state !== 'orphaned') return false;
        if ((await countMediaReferences(tx, id)).total > 0) return false; // re-referenced meanwhile (Invariant #12)
        await transitionMedia(tx, id, 'soft_deleted');
        return true;
      });
      if (done) softDeleted++;
    }

    const expired = await this.prisma.mediaAsset.findMany({
      where: { lifecycleState: 'soft_deleted', deletedAt: { lte: purgeCutoff } },
      select: { id: true, storageKey: true },
      take: 1000,
    });
    for (const a of expired) {
      await this.storage.delete(a.storageKey).catch((e: Error) => this.logger.warn(`Could not delete object ${a.storageKey}: ${e.message}`));
      await this.prisma.$transaction((tx) => transitionMedia(tx, a.id, 'purged'));
      purged++;
    }
    return { softDeleted, purged };
  }
}
