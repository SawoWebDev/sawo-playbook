import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { rm } from 'fs/promises';
import { AuthUser } from '../common/auth-user';
import { AuditAction, AuditService } from '../audit/audit.service';
import { ALLOWED_UPLOADS, imageSize, sniffMime } from '../media/file-sniff';
import { MalwareScanner } from '../media/malware-scanner';
import { PrismaService } from '../prisma/prisma.service';
import { recomputeSopStatus } from '../sops/sop-status';
import { sanitizeRichText } from '../sops/sanitize';
import { StorageService } from '../storage/storage.service';
import { BackupFolder, BackupMediaEntry, BackupSop, MAX_JSON_ENTRY_BYTES } from './backup-format';
import { BackupFormatError, parseFolders, parseManifest, parseMedia, parseSop, parseUsers } from './backup-parse';
import { BackupJob, BackupJobs, RestoreSummary } from './backup-jobs';
import { ZipReader } from './zip-reader';

const MAX_MEDIA_BYTES = Math.max(...Object.values(ALLOWED_UPLOADS).map((r) => r.maxBytes));

const linkedSopIds = (s: BackupSop): string[] => [...new Set(s.versions.flatMap((v) => v.steps.map((st) => st.linkedSopId).filter((x): x is string => !!x)))];

/** Dependencies first (oldest first otherwise), so a step's link to another SOP already exists when the step is written. */
function dependencyOrder(sops: BackupSop[]): BackupSop[] {
  const byId = new Map(sops.map((s) => [s.id, s]));
  const state = new Set<string>();
  const out: BackupSop[] = [];
  const visit = (s: BackupSop) => {
    if (state.has(s.id)) return;
    state.add(s.id);
    for (const dep of linkedSopIds(s)) {
      const d = byId.get(dep);
      if (d && d.id !== s.id) visit(d);
    }
    out.push(s);
  };
  [...sops].sort((a, b) => b.position - a.position).forEach(visit);
  return out;
}

@Injectable()
export class BackupRestorer {
  private readonly log = new Logger(BackupRestorer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly scanner: MalwareScanner,
    private readonly jobs: BackupJobs,
    private readonly audit: AuditService,
  ) {}

  /** Runs in the background; never throws — failures are recorded on the job. The uploaded file is always removed afterwards. */
  async run(job: BackupJob, actor: AuthUser, zipPath: string): Promise<void> {
    let zip: ZipReader | undefined;
    try {
      zip = await ZipReader.open(zipPath);
      await this.restore(job, actor, zip);
      await this.jobs.finish(job);
    } catch (err) {
      if (!(err instanceof BackupFormatError)) this.log.error(`Restore ${job.id} failed: ${err instanceof Error ? err.stack : err}`);
      await this.jobs.fail(job, err);
    } finally {
      zip?.close();
      await rm(zipPath, { force: true });
    }
  }

  private async loadMedia(zip: ZipReader, entry: BackupMediaEntry) {
    if (entry.missing) throw new Error('the file was already missing when the backup was made');
    if (!zip.has(entry.file)) throw new Error('the file is not in the backup');
    const bytes = await zip.read(entry.file, MAX_MEDIA_BYTES);
    if (entry.sha256 && createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('checksum does not match (the file is damaged)');
    const mime = sniffMime(bytes);
    const rule = mime ? ALLOWED_UPLOADS[mime] : undefined;
    if (!mime || !rule) throw new Error('unsupported file type');
    if (bytes.length > rule.maxBytes) throw new Error('file is too large');
    const verdict = await this.scanner.scan(bytes);
    if (!verdict.clean) throw new Error(`rejected by the malware scan (${verdict.signature})`);
    return { bytes, mime, rule };
  }

  private async restore(job: BackupJob, actor: AuthUser, zip: ZipReader): Promise<void> {
    const orgId = actor.organizationId;
    const dryRun = job.dryRun;

    // ── read & validate the whole file before anything is written ──
    job.phase = 'validating';
    job.current = 'Reading backup index';
    const manifest = parseManifest(await zip.readJson('manifest.json', MAX_JSON_ENTRY_BYTES));
    const folders = parseFolders(await zip.readJson(manifest.files.folders, MAX_JSON_ENTRY_BYTES));
    const users = parseUsers(await zip.readJson(manifest.files.users, MAX_JSON_ENTRY_BYTES));
    const mediaIndex = parseMedia(await zip.readJson(manifest.files.media, MAX_JSON_ENTRY_BYTES));
    const mediaById = new Map(mediaIndex.map((m) => [m.id, m]));

    const summary: RestoreSummary = {
      dryRun,
      sopsInFile: manifest.files.sops.length,
      created: 0,
      skipped: [],
      failed: [],
      versions: 0,
      steps: 0,
      mediaCreated: 0,
      foldersCreated: 0,
      usersCreated: 0,
      usersMatched: 0,
    };
    job.summary = summary;

    job.total.sops = manifest.files.sops.length;
    this.jobs.setPercent(job);
    const sops: BackupSop[] = [];
    for (const file of manifest.files.sops) {
      job.current = file;
      try {
        sops.push(parseSop(await zip.readJson(file, MAX_JSON_ENTRY_BYTES), file));
      } catch (e) {
        summary.failed.push({ referenceNo: file, name: file, error: e instanceof Error ? e.message : String(e) });
      }
      job.done.sops += 1;
      this.jobs.setPercent(job);
    }

    // ── plan: what already exists, what is a duplicate inside the file ──
    job.current = 'Checking for existing SOPs';
    const refs = sops.map((s) => s.referenceNo);
    const existing = await this.prisma.sop.findMany({ where: { organizationId: orgId, referenceNo: { in: refs } }, select: { id: true, referenceNo: true, deletedAt: true } });
    const existingByRef = new Map(existing.map((e) => [e.referenceNo, e]));
    const seen = new Set<string>();
    const toCreate: BackupSop[] = [];
    const existingSopIdFor = new Map<string, string>(); // backup sop id -> id of the SOP that already exists here
    for (const s of sops) {
      const have = existingByRef.get(s.referenceNo);
      if (have) {
        summary.skipped.push({
          referenceNo: s.referenceNo,
          name: s.name,
          reason: have.deletedAt ? 'its reference number is held by a deleted SOP' : 'a SOP with this reference number already exists',
        });
        if (!have.deletedAt) existingSopIdFor.set(s.id, have.id);
      } else if (seen.has(s.referenceNo)) {
        summary.failed.push({ referenceNo: s.referenceNo, name: s.name, error: 'the same reference number appears twice in this file' });
      } else {
        seen.add(s.referenceNo);
        toCreate.push(s);
      }
    }

    const publishedAssets = new Set<string>();
    const neededAssets = new Set<string>();
    for (const s of toCreate)
      for (const v of s.versions)
        for (const st of v.steps)
          for (const m of st.media) {
            neededAssets.add(m.assetId);
            if (v.lifecycleState === 'PUBLISHED') publishedAssets.add(m.assetId);
          }

    job.done = { sops: 0, media: 0 };
    job.total = { sops: toCreate.length, media: neededAssets.size };
    this.jobs.setPercent(job);

    if (dryRun) {
      // A dry run checks every image too (checksum, type, malware scan) but writes nothing.
      for (const assetId of neededAssets) {
        const entry = mediaById.get(assetId);
        job.current = entry?.originalFilename ?? assetId;
        try {
          if (!entry) throw new Error('it is not listed in the backup');
          const { bytes } = await this.loadMedia(zip, entry);
          job.bytes += bytes.length;
        } catch (e) {
          this.jobs.warn(job, `Image "${entry?.originalFilename ?? assetId}": ${e instanceof Error ? e.message : e}`);
        }
        job.done.media += 1;
        this.jobs.setPercent(job);
      }
      job.done.sops = toCreate.length;
      summary.created = toCreate.length;
      summary.versions = toCreate.reduce((n, s) => n + s.versions.length, 0);
      summary.steps = toCreate.reduce((n, s) => n + s.versions.reduce((m, v) => m + v.steps.length, 0), 0);
      return;
    }

    // ── people & folders ──
    job.phase = 'restoring';
    job.current = 'Matching people and folders';
    const userMap = await this.resolveUsers(orgId, actor, users, summary, job);
    const uid = (old: string | null | undefined): string => (old ? userMap.get(old) ?? actor.id : actor.id);
    const folderMap = await this.resolveFolders(orgId, actor, folders, summary);

    // ── ids up front so links between SOPs can be remapped ──
    const ordered = dependencyOrder(toCreate);
    const sopIdMap = new Map(ordered.map((s) => [s.id, randomUUID()]));
    const versionIdMap = new Map(ordered.flatMap((s) => s.versions.map((v) => [v.id, randomUUID()] as const)));
    const takenTokens = new Set(
      (await this.prisma.sop.findMany({ where: { qrPublicToken: { in: ordered.map((s) => s.qrPublicToken).filter(Boolean) } }, select: { qrPublicToken: true } })).map((t) => t.qrPublicToken),
    );
    const createdSops = new Set<string>(); // backup ids already written
    const createdVersions = new Set<string>();
    const assetMap = new Map<string, string>();
    const assetFailed = new Set<string>();
    let removedLinks = 0;

    const ensureAsset = async (oldId: string): Promise<void> => {
      if (assetMap.has(oldId) || assetFailed.has(oldId)) return;
      const entry = mediaById.get(oldId);
      job.current = entry?.originalFilename ?? oldId;
      try {
        if (!entry) throw new Error('it is not listed in the backup');
        const { bytes, mime, rule } = await this.loadMedia(zip, entry);
        const newId = randomUUID();
        const storageKey = `org/${orgId}/media/${newId}`;
        await this.storage.put(storageKey, bytes, mime);
        const dims = rule.type === 'image' ? imageSize(bytes, mime) : null;
        await this.prisma.mediaAsset.create({
          data: {
            id: newId,
            organizationId: orgId,
            type: rule.type,
            storageKey,
            originalFilename: entry.originalFilename.replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file',
            mimeType: mime,
            sizeBytes: BigInt(bytes.length),
            checksum: createHash('sha256').update(bytes).digest('hex'),
            width: dims?.width ?? entry.width,
            height: dims?.height ?? entry.height,
            durationSeconds: entry.durationSeconds,
            lifecycleState: publishedAssets.has(oldId) ? 'referenced' : 'attached',
            createdById: uid(entry.createdById),
            createdAt: new Date(entry.createdAt),
          },
        });
        assetMap.set(oldId, newId);
        summary.mediaCreated += 1;
        job.bytes += bytes.length;
      } catch (e) {
        assetFailed.add(oldId);
        this.jobs.warn(job, `Image "${entry?.originalFilename ?? oldId}" was not restored: ${e instanceof Error ? e.message : e}`);
      }
      job.done.media += 1;
      this.jobs.setPercent(job);
    };

    // ── one SOP at a time, each in its own transaction ──
    for (const sop of ordered) {
      job.current = sop.name;
      try {
        for (const v of sop.versions) for (const st of v.steps) for (const m of st.media) await ensureAsset(m.assetId);

        const newSopId = sopIdMap.get(sop.id)!;
        const linkSop = (old: string | null): string | null => {
          if (!old) return null;
          if (createdSops.has(old)) return sopIdMap.get(old)!;
          const ex = existingSopIdFor.get(old);
          if (ex) return ex;
          removedLinks += 1;
          return null;
        };
        const counts = { versions: 0, steps: 0 };
        await this.prisma.$transaction(
          async (tx) => {
            await tx.sop.create({
              data: {
                id: newSopId,
                organizationId: orgId,
                referenceNo: sop.referenceNo,
                name: sop.name,
                type: sop.type,
                folderId: sop.folderId ? folderMap.get(sop.folderId) ?? null : null,
                qrPublicToken: sop.qrPublicToken && !takenTokens.has(sop.qrPublicToken) ? sop.qrPublicToken : randomBytes(18).toString('base64url'),
                archivedAt: sop.archivedAt ? new Date(sop.archivedAt) : null,
                createdById: uid(sop.createdById),
                createdAt: new Date(sop.createdAt),
                updatedAt: new Date(sop.updatedAt),
              },
            });
            // Oldest version first: only one version per SOP may be unpublished, and a published one can't be edited afterwards.
            for (const v of sop.versions) {
              const newVid = versionIdMap.get(v.id)!;
              await tx.sopVersion.create({
                data: {
                  id: newVid,
                  organizationId: orgId,
                  sopId: newSopId,
                  versionSequence: v.versionSequence,
                  config: v.config as Prisma.InputJsonValue,
                  lifecycleState: 'DRAFT', // steps can only be written while a version is a draft
                  currentApprovalRound: v.currentApprovalRound,
                  changeSummary: v.changeSummary,
                  createdById: uid(v.createdById),
                  createdAt: new Date(v.createdAt),
                },
              });
              const stepRows = v.steps.map((s) => ({ s, id: randomUUID() }));
              if (stepRows.length) {
                await tx.sopStep.createMany({
                  data: stepRows.map(({ s, id }) => ({
                    id,
                    organizationId: orgId,
                    sopVersionId: newVid,
                    order: s.order,
                    title: s.title,
                    description: sanitizeRichText(s.description),
                    isTextOnly: s.isTextOnly,
                    isCritical: s.isCritical,
                    usesOkNotokMedia: s.usesOkNotokMedia,
                    plannedTimeSeconds: s.plannedTimeSeconds,
                    linkedSopId: linkSop(s.linkedSopId),
                    linkedSopVersionId: s.linkedSopVersionId && createdVersions.has(s.linkedSopVersionId) ? versionIdMap.get(s.linkedSopVersionId)! : null,
                  })),
                });
                const mediaRows = stepRows.flatMap(({ s, id }) => {
                  const used = new Set<string>();
                  return s.media.flatMap((m) => {
                    const assetId = assetMap.get(m.assetId);
                    if (!assetId || used.has(assetId)) return [];
                    used.add(assetId);
                    return [{ sopStepId: id, mediaAssetId: assetId, displayOrder: m.displayOrder }];
                  });
                });
                if (mediaRows.length) await tx.sopStepMedia.createMany({ data: mediaRows });
              }
              if (v.lifecycleState !== 'DRAFT') {
                await tx.sopVersion.update({
                  where: { id: newVid },
                  data: {
                    lifecycleState: v.lifecycleState,
                    submittedAt: v.submittedAt ? new Date(v.submittedAt) : null,
                    submittedById: v.submittedById ? uid(v.submittedById) : null,
                    approvedAt: v.approvedAt ? new Date(v.approvedAt) : null,
                    publishedAt: v.publishedAt ? new Date(v.publishedAt) : null,
                    publishedById: v.publishedById ? uid(v.publishedById) : null,
                  },
                });
              }
              if (v.approvals.length) {
                await tx.sopVersionApproval.createMany({
                  data: v.approvals.map((a) => ({
                    organizationId: orgId,
                    sopVersionId: newVid,
                    approvalRound: a.approvalRound,
                    approverId: uid(a.approverId),
                    decision: a.decision,
                    comment: a.comment,
                    createdAt: new Date(a.createdAt),
                  })),
                  skipDuplicates: true,
                });
              }
              counts.versions += 1;
              counts.steps += v.steps.length;
            }
            await tx.sop.update({
              where: { id: newSopId },
              data: { currentPublishedVersionId: sop.currentPublishedVersionId ? versionIdMap.get(sop.currentPublishedVersionId) ?? null : null },
            });
            await recomputeSopStatus(tx, newSopId);
            await tx.sop.update({ where: { id: newSopId }, data: { updatedAt: new Date(sop.updatedAt) } });
          },
          { timeout: 120_000, maxWait: 15_000 },
        );
        createdSops.add(sop.id);
        for (const v of sop.versions) createdVersions.add(v.id);
        summary.created += 1;
        summary.versions += counts.versions;
        summary.steps += counts.steps;
      } catch (e) {
        summary.failed.push({ referenceNo: sop.referenceNo, name: sop.name, error: e instanceof Error ? e.message.split('\n').filter(Boolean).pop() ?? 'failed' : String(e) });
      }
      job.done.sops += 1;
      this.jobs.setPercent(job);
    }
    if (removedLinks) this.jobs.warn(job, `${removedLinks} step link(s) to SOPs that are not in this backup were removed`);

    await this.audit.record({
      action: AuditAction.BackupRestored,
      organizationId: orgId,
      actorId: actor.id,
      entityType: 'backup',
      entityId: job.id,
      metadata: { created: summary.created, skipped: summary.skipped.length, failed: summary.failed.length, source: job.sourceName ?? '' },
    });
  }

  /** People in the file are matched to existing users by email; unknown ones become attribution-only placeholders (invited, lowest role, no password). */
  private async resolveUsers(orgId: string, actor: AuthUser, users: { id: string; name: string; email: string }[], summary: RestoreSummary, job: BackupJob): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const inOrg = new Map((await this.prisma.user.findMany({ where: { organizationId: orgId }, select: { id: true, email: true } })).map((u) => [u.email.toLowerCase(), u.id]));
    const unmatched = users.filter((u) => !inOrg.has(u.email.toLowerCase()));
    const elsewhere = new Set((await this.prisma.user.findMany({ where: { email: { in: unmatched.map((u) => u.email) } }, select: { email: true } })).map((u) => u.email.toLowerCase()));
    for (const u of users) {
      const have = inOrg.get(u.email.toLowerCase());
      if (have) {
        map.set(u.id, have);
        summary.usersMatched += 1;
        continue;
      }
      if (elsewhere.has(u.email.toLowerCase())) {
        this.jobs.warn(job, `${u.name} <${u.email}> belongs to another organization, so their SOPs are attributed to you instead`);
        continue;
      }
      try {
        const created = await this.prisma.user.create({ data: { organizationId: orgId, email: u.email, name: u.name, status: 'invited', orgRole: 'OPERATOR' } });
        map.set(u.id, created.id);
        summary.usersCreated += 1;
      } catch {
        this.jobs.warn(job, `${u.name} <${u.email}> could not be created, so their SOPs are attributed to ${actor.name}`);
      }
    }
    return map;
  }

  /** Folders are matched by name under the same parent; missing ones are created. */
  private async resolveFolders(orgId: string, actor: AuthUser, folders: BackupFolder[], summary: RestoreSummary): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const existing = await this.prisma.folder.findMany({ where: { organizationId: orgId, deletedAt: null } });
    const key = (parent: string | null, name: string) => `${parent ?? ''}\n${name.trim().toLowerCase()}`;
    const byKey = new Map(existing.map((f) => [key(f.parentId, f.name), f.id]));
    let pending = [...folders];
    while (pending.length) {
      const next: BackupFolder[] = [];
      for (const f of pending) {
        if (f.parentId && !map.has(f.parentId) && folders.some((x) => x.id === f.parentId)) {
          next.push(f);
          continue;
        }
        const parent = f.parentId ? map.get(f.parentId) ?? null : null;
        const k = key(parent, f.name);
        let id = byKey.get(k);
        if (!id) {
          id = (await this.prisma.folder.create({ data: { organizationId: orgId, parentId: parent, name: f.name.trim(), createdById: actor.id, createdAt: new Date(f.createdAt) } })).id;
          byKey.set(k, id);
          summary.foldersCreated += 1;
        }
        map.set(f.id, id);
      }
      if (next.length === pending.length) break; // cycle or orphaned parent — leave the rest at the root
      pending = next;
    }
    return map;
  }
}
