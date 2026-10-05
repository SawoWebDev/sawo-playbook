import { Injectable, Logger } from '@nestjs/common';
import archiver from 'archiver';
import { createHash } from 'crypto';
import { createWriteStream } from 'fs';
import { mkdir, rename, rm, stat } from 'fs/promises';
import { AuthUser } from '../common/auth-user';
import { AuditAction, AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BackupFolder,
  BackupManifest,
  BackupMediaEntry,
  BackupSop,
  BackupUser,
  BackupVersion,
} from './backup-format';
import { BackupJob, BackupJobs, backupDir, backupPartPath, backupZipPath } from './backup-jobs';

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'video/mp4': '.mp4',
};

function mediaExt(mime: string, originalFilename: string): string {
  if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  const m = /\.[a-z0-9]{1,8}$/i.exec(originalFilename);
  return m ? m[0].toLowerCase() : '';
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

@Injectable()
export class BackupExporter {
  private readonly log = new Logger(BackupExporter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly jobs: BackupJobs,
    private readonly audit: AuditService,
  ) {}

  /** Runs to completion in the background; never throws — failures are recorded on the job. */
  async run(job: BackupJob, actor: AuthUser): Promise<void> {
    const orgId = job.organizationId;
    const part = backupPartPath(orgId, job.id);
    const final = backupZipPath(orgId, job.id);
    let out: ReturnType<typeof createWriteStream> | undefined;
    let archive: archiver.Archiver | undefined;
    try {
      await mkdir(backupDir(orgId), { recursive: true });
      out = createWriteStream(part);
      archive = archiver('zip', { zlib: { level: 6 } });
      const arc = archive;
      const closed = new Promise<void>((resolve, reject) => {
        out!.on('close', resolve);
        out!.on('error', reject);
        arc.on('error', reject);
      });
      closed.catch(() => undefined); // surfaced by the awaits below
      arc.pipe(out);

      // Add one entry and wait until archiver has fully written it, so at most one file is in memory at a time.
      const waiting = new Map<string, () => void>();
      arc.on('entry', (e) => waiting.get(e.name)?.());
      const add = (name: string, data: Buffer, store = false) =>
        new Promise<void>((resolve) => {
          waiting.set(name, () => {
            waiting.delete(name);
            resolve();
          });
          arc.append(data, { name, store });
        });
      const addJson = (name: string, value: unknown) => add(name, Buffer.from(JSON.stringify(value, null, 1), 'utf8'));

      // ── preparing ──
      job.phase = 'preparing';
      job.current = 'Reading organization';
      const [org, creator, folderRows, sopRows, mediaRefs] = await Promise.all([
        this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true } }),
        this.prisma.user.findUnique({ where: { id: actor.id }, select: { name: true, email: true } }),
        this.prisma.folder.findMany({ where: { organizationId: orgId, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
        this.prisma.sop.findMany({ where: { organizationId: orgId, deletedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], select: { id: true } }),
        this.prisma.sopStepMedia.findMany({
          where: { sopStep: { sopVersion: { lifecycleState: { not: 'ABANDONED' }, sop: { organizationId: orgId, deletedAt: null } } } },
          select: { mediaAssetId: true },
          distinct: ['mediaAssetId'],
        }),
      ]);
      job.total.sops = sopRows.length;
      job.total.media = mediaRefs.length;
      this.jobs.setPercent(job);

      // ── SOPs ──
      job.phase = 'sops';
      const userIds = new Set<string>();
      const mediaIds = new Set<string>();
      const sopFiles: string[] = [];
      let versionCount = 0;
      let stepCount = 0;
      for (const [index, { id }] of sopRows.entries()) {
        const sop = await this.prisma.sop.findUniqueOrThrow({
          where: { id },
          include: {
            versions: {
              where: { lifecycleState: { not: 'ABANDONED' } },
              orderBy: { versionSequence: 'asc' },
              include: {
                steps: { orderBy: { order: 'asc' }, include: { media: { orderBy: { displayOrder: 'asc' } } } },
                approvals: { orderBy: [{ approvalRound: 'asc' }, { createdAt: 'asc' }] },
              },
            },
          },
        });
        job.current = sop.name;
        userIds.add(sop.createdById);
        const versions: BackupVersion[] = sop.versions.map((v) => {
          for (const uid of [v.createdById, v.submittedById, v.publishedById]) if (uid) userIds.add(uid);
          for (const a of v.approvals) userIds.add(a.approverId);
          versionCount += 1;
          stepCount += v.steps.length;
          return {
            id: v.id,
            versionSequence: v.versionSequence,
            config: (v.config ?? {}) as Record<string, unknown>,
            lifecycleState: v.lifecycleState as BackupVersion['lifecycleState'],
            currentApprovalRound: v.currentApprovalRound,
            changeSummary: v.changeSummary,
            createdAt: v.createdAt.toISOString(),
            createdById: v.createdById,
            submittedAt: iso(v.submittedAt),
            submittedById: v.submittedById,
            approvedAt: iso(v.approvedAt),
            publishedAt: iso(v.publishedAt),
            publishedById: v.publishedById,
            steps: v.steps.map((s) => {
              for (const m of s.media) mediaIds.add(m.mediaAssetId);
              return {
                id: s.id,
                order: s.order,
                title: s.title,
                description: s.description,
                isTextOnly: s.isTextOnly,
                isCritical: s.isCritical,
                usesOkNotokMedia: s.usesOkNotokMedia,
                plannedTimeSeconds: s.plannedTimeSeconds,
                linkedSopId: s.linkedSopId,
                linkedSopVersionId: s.linkedSopVersionId,
                media: s.media.map((m) => ({ assetId: m.mediaAssetId, displayOrder: m.displayOrder })),
              };
            }),
            approvals: v.approvals.map((a) => ({
              approvalRound: a.approvalRound,
              approverId: a.approverId,
              decision: a.decision,
              comment: a.comment,
              createdAt: a.createdAt.toISOString(),
            })),
          };
        });
        const body: BackupSop = {
          id: sop.id,
          position: index + 1,
          referenceNo: sop.referenceNo,
          name: sop.name,
          type: sop.type as BackupSop['type'],
          status: sop.status,
          folderId: sop.folderId,
          archivedAt: iso(sop.archivedAt),
          qrPublicToken: sop.qrPublicToken,
          createdAt: sop.createdAt.toISOString(),
          updatedAt: sop.updatedAt.toISOString(),
          createdById: sop.createdById,
          currentPublishedVersionId: sop.currentPublishedVersionId,
          versions,
        };
        const safeRef = sop.referenceNo.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40) || 'sop';
        const file = `sops/${String(index + 1).padStart(4, '0')}-${safeRef}.json`;
        await addJson(file, body);
        sopFiles.push(file);
        job.done.sops = index + 1;
        job.bytes = arc.pointer();
        this.jobs.setPercent(job);
      }

      // ── media ──
      job.phase = 'media';
      job.total.media = mediaIds.size;
      this.jobs.setPercent(job);
      const assets = await this.prisma.mediaAsset.findMany({ where: { id: { in: [...mediaIds] } }, orderBy: { createdAt: 'asc' } });
      const mediaEntries: BackupMediaEntry[] = [];
      let mediaBytes = 0;
      for (const asset of assets) {
        job.current = asset.originalFilename;
        const file = `media/${asset.id}${mediaExt(asset.mimeType, asset.originalFilename)}`;
        const base: BackupMediaEntry = {
          id: asset.id,
          file,
          type: asset.type,
          originalFilename: asset.originalFilename,
          mimeType: asset.mimeType,
          sizeBytes: Number(asset.sizeBytes),
          sha256: asset.checksum ?? '',
          width: asset.width,
          height: asset.height,
          durationSeconds: asset.durationSeconds,
          createdAt: asset.createdAt.toISOString(),
          createdById: asset.createdById,
        };
        userIds.add(asset.createdById);
        try {
          const bytes = await this.storage.get(asset.storageKey);
          base.sha256 = createHash('sha256').update(bytes).digest('hex');
          base.sizeBytes = bytes.length;
          mediaBytes += bytes.length;
          await add(file, bytes, true); // images are already compressed
        } catch {
          base.missing = true;
          this.jobs.warn(job, `File for "${asset.originalFilename}" (${asset.id}) was not found in storage and is not in the backup`);
        }
        mediaEntries.push(base);
        job.done.media += 1;
        job.bytes = arc.pointer();
        this.jobs.setPercent(job);
      }
      for (const id of mediaIds) {
        if (!assets.some((a) => a.id === id)) this.jobs.warn(job, `Media asset ${id} is referenced by a step but no longer exists`);
      }

      // ── finalizing ──
      job.phase = 'finalizing';
      job.current = 'Writing index files';
      const users: BackupUser[] = (
        await this.prisma.user.findMany({ where: { id: { in: [...userIds] }, organizationId: orgId }, select: { id: true, name: true, email: true }, orderBy: { name: 'asc' } })
      ).map((u) => ({ id: u.id, name: u.name, email: u.email }));
      const folders: BackupFolder[] = folderRows.map((f) => ({ id: f.id, parentId: f.parentId, name: f.name, createdAt: f.createdAt.toISOString() }));
      await addJson('folders.json', folders);
      await addJson('users.json', users);
      await addJson('media.json', mediaEntries);
      const manifest: BackupManifest = {
        format: BACKUP_FORMAT,
        formatVersion: BACKUP_FORMAT_VERSION,
        createdAt: new Date().toISOString(),
        createdBy: { name: creator?.name ?? actor.name, email: creator?.email ?? actor.email },
        organization: { name: org.name },
        source: { app: 'sawo-gemba-docs' },
        counts: { folders: folders.length, users: users.length, sops: sopRows.length, versions: versionCount, steps: stepCount, media: mediaEntries.filter((m) => !m.missing).length, mediaBytes },
        files: { folders: 'folders.json', users: 'users.json', media: 'media.json', sops: sopFiles },
        warnings: job.warnings.slice(),
      };
      await addJson('manifest.json', manifest);
      await arc.finalize();
      await closed;
      await rename(part, final);

      const size = (await stat(final)).size;
      job.bytes = size;
      job.file = {
        name: `gemba-sop-backup-${manifest.createdAt.slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}.zip`,
        sizeBytes: size,
        counts: { sops: sopRows.length, versions: versionCount, steps: stepCount, media: manifest.counts.media },
      };
      this.jobs.setPercent(job, true);
      await this.audit.record({
        action: AuditAction.BackupExported,
        organizationId: orgId,
        actorId: actor.id,
        entityType: 'backup',
        entityId: job.id,
        metadata: { ...job.file.counts, sizeBytes: size },
      });
      await this.jobs.finish(job);
    } catch (err) {
      this.log.error(`Backup ${job.id} failed: ${err instanceof Error ? err.stack : err}`);
      archive?.abort();
      out?.destroy();
      await rm(part, { force: true });
      await this.jobs.fail(job, err);
    }
  }
}
