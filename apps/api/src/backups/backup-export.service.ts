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
  BackupKanban,
  BackupManifest,
  BackupMediaEntry,
  BackupSection,
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

/** Media asset ids a kanban revision refers to in its proposed card fields. */
function payloadMediaIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as Record<string, unknown>;
  const ids = typeof p.pictureAssetId === 'string' ? [p.pictureAssetId] : [];
  if (Array.isArray(p.mediaAssetIds)) for (const m of p.mediaAssetIds) if (typeof m === 'string') ids.push(m);
  return ids;
}

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
      // Each section is read only when it was chosen. Users and media are pulled in by the sections that refer to them.
      const want = new Set<BackupSection>(job.sections);
    const withPasswords = want.has('people') && job.includePasswords;
    if (withPasswords) {
      this.jobs.warn(job, 'This backup contains sign-in password hashes. Keep the file private and delete it once the transfer is done.');
    }
      job.phase = 'preparing';
      job.current = 'Reading organization';
      const [org, creator, folderRows, sopRows, kanbanRows] = await Promise.all([
        this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true } }),
        this.prisma.user.findUnique({ where: { id: actor.id }, select: { name: true, email: true } }),
        want.has('sops') ? this.prisma.folder.findMany({ where: { organizationId: orgId, deletedAt: null }, orderBy: { createdAt: 'asc' } }) : [],
        want.has('sops') ? this.prisma.sop.findMany({ where: { organizationId: orgId, deletedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], select: { id: true } }) : [],
        want.has('kanbans')
          ? this.prisma.kanban.findMany({
              where: { organizationId: orgId, deletedAt: null },
              orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
              include: { media: { select: { mediaAssetId: true }, orderBy: { mediaAssetId: 'asc' } } },
            })
          : [],
      ]);
      job.total.sops = sopRows.length;
      job.total.kanbans = kanbanRows.length;
      job.total.media = 0;
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

      // ── kanbans ──
      job.phase = 'kanbans';
      const kanbans: BackupKanban[] = [];
      for (const [index, k] of kanbanRows.entries()) {
        job.current = k.partCode;
        userIds.add(k.createdById);
        if (k.pictureAssetId) mediaIds.add(k.pictureAssetId);
        for (const m of k.media) mediaIds.add(m.mediaAssetId);
        kanbans.push({
          id: k.id,
          position: index + 1,
          partCode: k.partCode,
          partDescription: k.partDescription,
          pictureAssetId: k.pictureAssetId,
          supplier: k.supplier,
          supplierPartNo: k.supplierPartNo,
          usedFor: k.usedFor,
          orderWhen: k.orderWhen,
          orderQty: k.orderQty,
          deliveryTime: k.deliveryTime,
          location: k.location,
          price: k.price === null ? null : k.price.toFixed(2),
          carriage: k.carriage === null ? null : k.carriage.toFixed(2),
          customField1: k.customField1,
          customField2: k.customField2,
          orderingType: k.orderingType,
          orderingUrl: k.orderingUrl,
          orderingSopId: k.orderingSopId,
          orderingEmail: k.orderingEmail,
          tag: k.tag,
          color: k.color,
          barcode: k.barcode,
          template: k.template,
          createdAt: k.createdAt.toISOString(),
          updatedAt: k.updatedAt.toISOString(),
          createdById: k.createdById,
          mediaAssetIds: k.media.map((m) => m.mediaAssetId),
        });
        job.done.kanbans = index + 1;
        this.jobs.setPercent(job);
      }
      job.current = 'Kanbans';
      await addJson('kanbans.json', kanbans);
      job.bytes = arc.pointer();

      // ── kanban revisions (open and past change proposals) ──
      const revisions = want.has('kanbans') ? await this.prisma.kanbanRevision.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: 'asc' } }) : [];
      if (want.has('kanbans')) {
        for (const r of revisions) {
          for (const uid of [r.createdById, r.updatedById, r.submittedById, r.preApprovedById, r.approvedById, r.publishedById, r.lastCommentById]) if (uid) userIds.add(uid);
          for (const m of payloadMediaIds(r.payload)) mediaIds.add(m);
        }
        await addJson(
          'kanban-revisions.json',
          revisions.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), submittedAt: iso(r.submittedAt), preApprovedAt: iso(r.preApprovedAt), approvedAt: iso(r.approvedAt), publishedAt: iso(r.publishedAt) })),
        );
      }

      // ── checklists: every submission with its responses ──
      const submissions = want.has('checklists')
        ? await this.prisma.checklistSubmission.findMany({ where: { organizationId: orgId }, orderBy: { startedAt: 'asc' }, include: { responses: { orderBy: { recordedAt: 'asc' } } } })
        : [];
      if (want.has('checklists')) {
        for (const sub of submissions) {
          userIds.add(sub.operatorId);
          for (const r of sub.responses) if (r.mediaAssetId) mediaIds.add(r.mediaAssetId);
        }
        await addJson(
          'checklists.json',
          submissions.map((s) => ({ ...s, startedAt: s.startedAt.toISOString(), completedAt: iso(s.completedAt), responses: s.responses.map((r) => ({ ...r, recordedAt: r.recordedAt.toISOString() })) })),
        );
      }

      // ── training: trainer assignments, assessments and current skill records ──
      if (want.has('training')) {
        const [trainerAssignments, skillAssessments, skillRecords] = await Promise.all([
          this.prisma.trainerAssignment.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: 'asc' } }),
          this.prisma.skillAssessment.findMany({ where: { organizationId: orgId }, orderBy: { assessedAt: 'asc' } }),
          this.prisma.skillRecord.findMany({ where: { organizationId: orgId } }),
        ]);
        for (const t of trainerAssignments) for (const uid of [t.trainerId, t.associateId, t.assignedById]) userIds.add(uid);
        for (const a of skillAssessments) for (const uid of [a.associateId, a.trainerId]) userIds.add(uid);
        for (const r of skillRecords) userIds.add(r.associateId);
        await addJson('training.json', {
          trainerAssignments: trainerAssignments.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })),
          skillAssessments: skillAssessments.map((a) => ({ ...a, assessedAt: a.assessedAt.toISOString() })),
          skillRecords: skillRecords.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })),
        });
      }

      // ── settings: approval rules, role permissions and menu layout ──
      if (want.has('settings')) {
        const settings = await this.prisma.organizationSettings.findUnique({ where: { organizationId: orgId } });
        await addJson('settings.json', settings ? { ...settings, organizationId: undefined, updatedAt: settings.updatedAt.toISOString() } : null);
      }

      // ── people: groups and pending invitations. Accounts are written with users.json below. ──
      const groupRows = want.has('people')
        ? await this.prisma.userGroup.findMany({ where: { organizationId: orgId }, orderBy: { name: 'asc' }, include: { members: { select: { userId: true } } } })
        : [];
      const invitationRows = want.has('people') ? await this.prisma.invitation.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: 'asc' } }) : [];
      const allUsers = want.has('people')
        ? await this.prisma.user.findMany({
            where: { organizationId: orgId },
            orderBy: { name: 'asc' },
            select: { id: true, name: true, email: true, orgRole: true, status: true, extraPermissions: true, mfaEnabled: true, lastLoginAt: true, createdAt: true, passwordHash: withPasswords },
          })
        : [];
      if (want.has('people')) {
        await addJson('groups.json', groupRows.map((g) => ({ id: g.id, name: g.name, createdAt: g.createdAt.toISOString(), memberIds: g.members.map((m) => m.userId) })));
        await addJson(
          'invitations.json',
          invitationRows.map((i) => ({ id: i.id, email: i.email, orgRole: i.orgRole, groupIds: i.groupIds, status: i.status, invitedById: i.invitedById, userId: i.userId, expiresAt: i.expiresAt.toISOString(), acceptedAt: iso(i.acceptedAt), createdAt: i.createdAt.toISOString() })),
        );
      }

      // ── activity events (the audit trail is not part of a backup) ──
      if (want.has('activity')) {
        const events = await this.prisma.activityEvent.findMany({ where: { organizationId: orgId }, orderBy: { occurredAt: 'asc' } });
        for (const e of events) if (e.actorId) userIds.add(e.actorId);
        await addJson('activity.json', events.map((e) => ({ ...e, occurredAt: e.occurredAt.toISOString() })));
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
      // With the people section every account is written. Without it, only the people other sections refer to.
      const users: BackupUser[] = want.has('people')
        ? allUsers.map((u) => ({
            id: u.id,
            name: u.name,
            email: u.email,
            orgRole: u.orgRole,
            status: u.status,
            extraPermissions: [...u.extraPermissions].sort(),
            mfaEnabled: u.mfaEnabled,
            lastLoginAt: iso(u.lastLoginAt),
            createdAt: u.createdAt.toISOString(),
            ...(withPasswords ? { passwordHash: (u as { passwordHash?: string | null }).passwordHash ?? null } : {}),
          }))
        : (await this.prisma.user.findMany({ where: { id: { in: [...userIds] }, organizationId: orgId }, select: { id: true, name: true, email: true }, orderBy: { name: 'asc' } })).map((u) => ({ id: u.id, name: u.name, email: u.email }));
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
        source: { app: 'sawo-playbook' },
        sections: [...job.sections],
        passwords: withPasswords,
        counts: {
          folders: folders.length,
          users: users.length,
          sops: sopRows.length,
          versions: versionCount,
          steps: stepCount,
          media: mediaEntries.filter((m) => !m.missing).length,
          mediaBytes,
          kanbans: kanbanRows.length,
          ...(want.has('kanbans') ? { kanbanRevisions: revisions.length } : {}),
          ...(want.has('people') ? { groups: groupRows.length, invitations: invitationRows.length } : {}),
          ...(want.has('checklists') ? { checklistSubmissions: submissions.length } : {}),
        },
        files: {
          folders: 'folders.json',
          users: 'users.json',
          media: 'media.json',
          sops: sopFiles,
          kanbans: 'kanbans.json',
          ...(want.has('kanbans') ? { kanbanRevisions: 'kanban-revisions.json' } : {}),
          ...(want.has('people') ? { groups: 'groups.json', invitations: 'invitations.json' } : {}),
          ...(want.has('checklists') ? { checklists: 'checklists.json' } : {}),
          ...(want.has('training') ? { training: 'training.json' } : {}),
          ...(want.has('settings') ? { settings: 'settings.json' } : {}),
          ...(want.has('activity') ? { activity: 'activity.json' } : {}),
        },
        warnings: job.warnings.slice(),
      };
      await addJson('manifest.json', manifest);
      await arc.finalize();
      await closed;
      await rename(part, final);

      const size = (await stat(final)).size;
      job.bytes = size;
      job.file = {
        name: `sawo-playbook-backup-${manifest.createdAt.slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}.zip`,
        sizeBytes: size,
        counts: { sops: sopRows.length, versions: versionCount, steps: stepCount, kanbans: kanbans.length, media: manifest.counts.media },
      };
      this.jobs.setPercent(job, true);
      await this.audit.record({
        action: AuditAction.BackupExported,
        organizationId: orgId,
        actorId: actor.id,
        entityType: 'backup',
        entityId: job.id,
        metadata: { ...job.file.counts, sections: [...job.sections], passwords: withPasswords, sizeBytes: size },
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
