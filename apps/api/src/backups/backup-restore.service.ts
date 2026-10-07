import { Injectable, Logger } from '@nestjs/common';
import { ChecklistResult, ChecklistStatus, KanbanRevisionState, OrgRole, Prisma, UserStatus } from '@prisma/client';
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
import { BackupFolder, BackupGroup, BackupKanban, BackupMediaEntry, BackupSettings, BackupSop, BackupTraining, BackupUser, MAX_JSON_ENTRY_BYTES } from './backup-format';
import { CONFIGURABLE_PERMISSIONS } from '../common/permissions';
import { BackupFormatError, parseActivity, parseChecklists, parseFolders, parseGroups, parseKanbans, parseManifest, parseMedia, parseRevisions, parseSettings, parseSop, parseTraining, parseUsers } from './backup-parse';
import { BackupJob, BackupJobs, RestoreExtraSummary, RestoreSummary } from './backup-jobs';
import { ZipReader } from './zip-reader';

const MAX_MEDIA_BYTES = Math.max(...Object.values(ALLOWED_UPLOADS).map((r) => r.maxBytes));

const CONFIGURABLE_SET = new Set<string>(CONFIGURABLE_PERMISSIONS);

const when = (v: string | null | undefined): Date | null => (v ? new Date(v) : null);

const emptyExtra = (): RestoreExtraSummary => ({
  groups: { inFile: 0, created: 0, memberships: 0 },
  settingsApplied: false,
  passwordAccounts: 0,
  invitationsInFile: 0,
  revisions: { inFile: 0, created: 0, skipped: 0 },
  checklists: { inFile: 0, created: 0, skipped: 0 },
  training: { trainers: 0, assessments: 0, records: 0, skipped: 0 },
  activity: { inFile: 0, created: 0 },
});

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

    const optionalFile = async <T>(key: string, parse: (raw: unknown) => T, fallback: T): Promise<T> => {
      const name = (manifest.files as Record<string, unknown>)[key];
      return typeof name === 'string' ? parse(await zip.readJson(name, MAX_JSON_ENTRY_BYTES)) : fallback;
    };
    const groupsFile = await optionalFile<BackupGroup[]>('groups', parseGroups, []);
    const settingsFile = await optionalFile<BackupSettings | null>('settings', parseSettings, null);
    const invitationsFile = await optionalFile<unknown[]>('invitations', (raw) => (Array.isArray(raw) ? raw : []), []);
    const revisionsFile = await optionalFile('kanbanRevisions', parseRevisions, []);
    const trainingFile = await optionalFile<BackupTraining | null>('training', parseTraining, null);
    const checklistsFile = await optionalFile('checklists', parseChecklists, []);
    const activityFile = await optionalFile('activity', parseActivity, []);

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
      kanbans: { inFile: 0, created: 0, skipped: 0, failed: [] },
      extra: emptyExtra(),
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

    let kanbanList: BackupKanban[] = [];
    if (manifest.files.kanbans) {
      job.current = 'Reading kanbans';
      const parsed = parseKanbans(await zip.readJson(manifest.files.kanbans, MAX_JSON_ENTRY_BYTES));
      kanbanList = parsed.kanbans;
      summary.kanbans.inFile = kanbanList.length + parsed.invalid.length;
      summary.kanbans.failed.push(...parsed.invalid);
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

    // A kanban has no unique key of its own: the same part code created at the same moment means "already restored".
    const haveKanbans = new Set(
      kanbanList.length
        ? (
            await this.prisma.kanban.findMany({
              where: { organizationId: orgId, deletedAt: null, partCode: { in: [...new Set(kanbanList.map((k) => k.partCode))] } },
              select: { partCode: true, createdAt: true },
            })
          ).map((k) => `${k.partCode}\n${k.createdAt.getTime()}`)
        : [],
    );
    const kanbansToCreate = kanbanList.filter((k) => {
      if (!haveKanbans.has(`${k.partCode}\n${new Date(k.createdAt).getTime()}`)) return true;
      summary.kanbans.skipped += 1;
      return false;
    });

    const publishedAssets = new Set<string>();
    const neededAssets = new Set<string>();
    for (const s of toCreate)
      for (const v of s.versions)
        for (const st of v.steps)
          for (const m of st.media) {
            neededAssets.add(m.assetId);
            if (v.lifecycleState === 'PUBLISHED') publishedAssets.add(m.assetId);
          }

    for (const k of kanbansToCreate) {
      if (k.pictureAssetId) neededAssets.add(k.pictureAssetId);
      for (const m of k.mediaAssetIds) neededAssets.add(m);
    }

    job.done = { sops: 0, kanbans: 0, media: 0 };
    job.total = { sops: toCreate.length, kanbans: kanbansToCreate.length, media: neededAssets.size };
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
      job.done.kanbans = kanbansToCreate.length;
      summary.kanbans.created = kanbansToCreate.length;
      summary.created = toCreate.length;
      summary.versions = toCreate.reduce((n, s) => n + s.versions.length, 0);
      summary.steps = toCreate.reduce((n, s) => n + s.versions.reduce((m, v) => m + v.steps.length, 0), 0);
      summary.extra.groups.inFile = groupsFile.length;
      summary.extra.invitationsInFile = invitationsFile.length;
      summary.extra.revisions.inFile = revisionsFile.length;
      summary.extra.checklists.inFile = checklistsFile.length;
      summary.extra.activity.inFile = activityFile.length;
      summary.extra.training = { trainers: trainingFile?.trainerAssignments.length ?? 0, assessments: trainingFile?.skillAssessments.length ?? 0, records: trainingFile?.skillRecords.length ?? 0, skipped: 0 };
      summary.extra.passwordAccounts = users.filter((u) => !!u.passwordHash).length;
      return;
    }

    // ── people, groups, settings & folders ──
    job.phase = 'restoring';
    job.current = 'Matching people and groups';
    const { userMap, created: createdUsers } = await this.resolveUsers(orgId, actor, users, summary, job);
    const uid = (old: string | null | undefined): string => (old ? userMap.get(old) ?? actor.id : actor.id);
    const groupMap = await this.restoreGroups(orgId, groupsFile, userMap, createdUsers, summary);
    await this.applySettings(orgId, settingsFile, summary);
    const folderMap = await this.resolveFolders(orgId, actor, folders, summary);

    // ── ids up front so links between SOPs can be remapped ──
    const ordered = dependencyOrder(toCreate);
    const sopIdMap = new Map(ordered.map((s) => [s.id, randomUUID()]));
    const versionIdMap = new Map(ordered.flatMap((s) => s.versions.map((v) => [v.id, randomUUID()] as const)));
    const takenTokens = new Set(
      (await this.prisma.sop.findMany({ where: { qrPublicToken: { in: ordered.map((s) => s.qrPublicToken).filter(Boolean) } }, select: { qrPublicToken: true } })).map((t) => t.qrPublicToken),
    );
    const stepIdMap = new Map<string, string>(); // backup step id -> restored step id
    const kanbanIdMap = new Map<string, string>(); // backup kanban id -> restored kanban id
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
        const stepsThisSop = new Map<string, string>();
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
              for (const { s, id } of stepRows) stepsThisSop.set(s.id, id);
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
        for (const [old, fresh] of stepsThisSop) stepIdMap.set(old, fresh);
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

    // ── kanbans (after the SOPs, so a kanban that orders from an SOP can point at the restored one) ──
    job.phase = 'restoring';
    for (const k of kanbansToCreate) {
      job.current = k.partCode;
      try {
        if (k.pictureAssetId) await ensureAsset(k.pictureAssetId);
        for (const m of k.mediaAssetIds) await ensureAsset(m);

        let orderingType = k.orderingType;
        let orderingUrl: string | null = k.orderingUrl;
        let orderingEmail: string | null = k.orderingEmail;
        let orderingSopId: string | null = null;
        if (orderingType === 'sop') {
          const target = k.orderingSopId ? (createdSops.has(k.orderingSopId) ? sopIdMap.get(k.orderingSopId) ?? null : existingSopIdFor.get(k.orderingSopId) ?? null) : null;
          orderingUrl = null;
          orderingEmail = null;
          if (target) orderingSopId = target;
          else {
            orderingType = 'url';
            this.jobs.warn(job, `Kanban "${k.partCode}": the SOP it orders from is not available here, so its ordering link was cleared`);
          }
        } else if (orderingType === 'email' && orderingEmail) {
          orderingUrl = null;
        } else {
          orderingType = 'url';
          orderingEmail = null;
        }
        const picture = k.pictureAssetId ? assetMap.get(k.pictureAssetId) ?? null : null;
        const extra = [...new Set(k.mediaAssetIds.map((m) => assetMap.get(m)).filter((x): x is string => !!x))];
        const newKanbanId = await this.prisma.$transaction(async (tx) => {
          const row = await tx.kanban.create({
            data: {
              organizationId: orgId,
              partCode: k.partCode,
              partDescription: k.partDescription,
              pictureAssetId: picture,
              supplier: k.supplier,
              supplierPartNo: k.supplierPartNo,
              usedFor: k.usedFor,
              orderWhen: k.orderWhen,
              orderQty: k.orderQty,
              deliveryTime: k.deliveryTime,
              location: k.location,
              price: k.price === null ? null : new Prisma.Decimal(k.price),
              carriage: k.carriage === null ? null : new Prisma.Decimal(k.carriage),
              customField1: k.customField1,
              customField2: k.customField2,
              orderingType,
              orderingUrl,
              orderingSopId,
              orderingEmail,
              tag: k.tag,
              color: k.color,
              barcode: k.barcode,
              template: k.template,
              createdById: uid(k.createdById),
              createdAt: new Date(k.createdAt),
              updatedAt: new Date(k.updatedAt),
            },
          });
          if (extra.length) await tx.kanbanMedia.createMany({ data: extra.map((mediaAssetId) => ({ kanbanId: row.id, mediaAssetId })) });
          return row.id;
        });
        kanbanIdMap.set(k.id, newKanbanId);
        summary.kanbans.created += 1;
      } catch (e) {
        summary.kanbans.failed.push({ partCode: k.partCode, error: e instanceof Error ? e.message.split('\n').filter(Boolean).pop() ?? 'failed' : String(e) });
      }
      job.done.kanbans += 1;
      this.jobs.setPercent(job);
    }

    // ── kanban proposals (open and past change requests) ──
    job.phase = 'restoring';
    job.current = 'Restoring kanban proposals';
    for (const r of revisionsFile) {
      job.current = `Kanban proposal ${r.id.slice(0, 8)}`;
      try {
        const kanbanId = r.kanbanId ? kanbanIdMap.get(r.kanbanId) ?? null : null;
        if (r.kanbanId && !kanbanId) {
          summary.extra.revisions.skipped += 1;
          continue;
        }
        const payload: Record<string, unknown> = { ...r.payload };
        if (typeof payload.pictureAssetId === 'string') {
          await ensureAsset(payload.pictureAssetId);
          payload.pictureAssetId = assetMap.get(payload.pictureAssetId) ?? null;
        }
        if (Array.isArray(payload.mediaAssetIds)) {
          const ids = payload.mediaAssetIds.filter((m): m is string => typeof m === 'string');
          for (const m of ids) await ensureAsset(m);
          payload.mediaAssetIds = [...new Set(ids.map((m) => assetMap.get(m)).filter((x): x is string => !!x))];
        }
        await this.prisma.kanbanRevision.create({
          data: {
            organizationId: orgId,
            kanbanId,
            state: r.state as KanbanRevisionState,
            payload: payload as Prisma.InputJsonValue,
            routingGroupIds: r.routingGroupIds.map((g) => groupMap.get(g)).filter((g): g is string => !!g),
            createdById: uid(r.createdById),
            updatedById: uid(r.updatedById),
            submittedById: r.submittedById ? uid(r.submittedById) : null,
            submittedAt: when(r.submittedAt),
            preApprovedById: r.preApprovedById ? uid(r.preApprovedById) : null,
            preApprovedAt: when(r.preApprovedAt),
            approvedById: r.approvedById ? uid(r.approvedById) : null,
            approvedAt: when(r.approvedAt),
            publishedById: r.publishedById ? uid(r.publishedById) : null,
            publishedAt: when(r.publishedAt),
            lastComment: r.lastComment,
            lastCommentById: r.lastCommentById ? uid(r.lastCommentById) : null,
            createdAt: new Date(r.createdAt),
            updatedAt: new Date(r.updatedAt),
          },
        });
        summary.extra.revisions.created += 1;
      } catch (e) {
        summary.extra.revisions.skipped += 1;
        this.jobs.warn(job, `A kanban proposal was not restored: ${e instanceof Error ? e.message.split('\n').filter(Boolean).pop() : String(e)}`);
      }
    }
    summary.extra.revisions.inFile = revisionsFile.length;

    // ── checklists: submissions of the SOP versions restored above ──
    for (const sub of checklistsFile) {
      const versionId = createdVersions.has(sub.sopVersionId) ? versionIdMap.get(sub.sopVersionId) : undefined;
      if (!versionId) {
        summary.extra.checklists.skipped += 1;
        continue;
      }
      try {
        const responses: { stepId: string; value: string | null; result: ChecklistResult | null; comment: string | null; mediaAssetId: string | null; recordedAt: Date }[] = [];
        for (const r of sub.responses) {
          const stepId = stepIdMap.get(r.stepId);
          if (!stepId) continue;
          let mediaAssetId: string | null = null;
          if (r.mediaAssetId) {
            await ensureAsset(r.mediaAssetId);
            mediaAssetId = assetMap.get(r.mediaAssetId) ?? null;
          }
          responses.push({ stepId, value: r.value, result: r.result as ChecklistResult | null, comment: r.comment, mediaAssetId, recordedAt: new Date(r.recordedAt) });
        }
        await this.prisma.checklistSubmission.create({
          data: {
            organizationId: orgId,
            sopVersionId: versionId,
            operatorId: uid(sub.operatorId),
            startedAt: new Date(sub.startedAt),
            completedAt: when(sub.completedAt),
            status: sub.status as ChecklistStatus,
            responses: { create: responses },
          },
        });
        summary.extra.checklists.created += 1;
      } catch (e) {
        summary.extra.checklists.skipped += 1;
        this.jobs.warn(job, `A checklist submission was not restored: ${e instanceof Error ? e.message.split('\n').filter(Boolean).pop() : String(e)}`);
      }
    }
    summary.extra.checklists.inFile = checklistsFile.length;

    // ── training: trainers, assessments and current skill levels of the SOPs restored above ──
    if (trainingFile) {
      const trainerRows = trainingFile.trainerAssignments.flatMap((t) => {
        const trainerId = userMap.get(t.trainerId);
        const associateId = userMap.get(t.associateId);
        return trainerId && associateId ? [{ organizationId: orgId, trainerId, associateId, assignedById: uid(t.assignedById), createdAt: new Date(t.createdAt) }] : [];
      });
      const assessmentIdMap = new Map<string, string>(); // backup assessment id -> restored id
      const assessmentRows = trainingFile.skillAssessments.flatMap((a) => {
        const sopId = createdSops.has(a.sopId) ? sopIdMap.get(a.sopId) : undefined;
        const sopVersionId = createdVersions.has(a.sopVersionId) ? versionIdMap.get(a.sopVersionId) : undefined;
        const associateId = userMap.get(a.associateId);
        const trainerId = userMap.get(a.trainerId);
        if (!sopId || !sopVersionId || !associateId || !trainerId) return [];
        const newId = randomUUID();
        assessmentIdMap.set(a.id, newId);
        return [{ id: newId, organizationId: orgId, associateId, sopId, sopVersionId, level: a.level, trainerId, assessedAt: new Date(a.assessedAt), notes: a.notes }];
      });
      const recordRows = trainingFile.skillRecords.flatMap((r) => {
        const sopId = createdSops.has(r.sopId) ? sopIdMap.get(r.sopId) : undefined;
        const currentSopVersionId = createdVersions.has(r.currentSopVersionId) ? versionIdMap.get(r.currentSopVersionId) : undefined;
        const associateId = userMap.get(r.associateId);
        const lastAssessmentId = assessmentIdMap.get(r.lastAssessmentId);
        if (!sopId || !currentSopVersionId || !associateId || !lastAssessmentId) return [];
        return [{ organizationId: orgId, associateId, sopId, currentLevel: r.currentLevel, currentSopVersionId, lastAssessmentId, updatedAt: new Date(r.updatedAt) }];
      });
      const trainers = await this.prisma.trainerAssignment.createMany({ data: trainerRows, skipDuplicates: true });
      await this.prisma.skillAssessment.createMany({ data: assessmentRows });
      const records = await this.prisma.skillRecord.createMany({ data: recordRows, skipDuplicates: true });
      summary.extra.training = {
        trainers: trainers.count,
        assessments: assessmentRows.length,
        records: records.count,
        skipped: trainingFile.trainerAssignments.length - trainerRows.length + (trainingFile.skillAssessments.length - assessmentRows.length) + (trainingFile.skillRecords.length - recordRows.length),
      };
    }

    // ── activity events: restored as new rows; references are remapped where the target was restored ──
    const mapEntity = (type: string | null, old: string | null): string | null => {
      if (!old) return null;
      if (type === 'sop') return sopIdMap.get(old) ?? existingSopIdFor.get(old) ?? old;
      if (type === 'kanban') return kanbanIdMap.get(old) ?? old;
      if (type === 'user') return userMap.get(old) ?? old;
      if (type === 'folder') return folderMap.get(old) ?? old;
      if (type === 'group') return groupMap.get(old) ?? old;
      return old;
    };
    for (let i = 0; i < activityFile.length; i += 1000) {
      const chunk = activityFile.slice(i, i + 1000);
      const written = await this.prisma.activityEvent.createMany({
        data: chunk.map((e) => ({
          id: randomUUID(), // new id: the source row may still exist on the same server
          organizationId: orgId,
          actorId: e.actorId ? userMap.get(e.actorId) ?? null : null,
          eventType: e.eventType,
          entityType: e.entityType,
          entityId: mapEntity(e.entityType, e.entityId),
          metadata: (e.metadata ?? {}) as Prisma.InputJsonValue,
          occurredAt: new Date(e.occurredAt),
        })),
        skipDuplicates: true,
      });
      summary.extra.activity.created += written.count;
    }
    summary.extra.activity.inFile = activityFile.length;

    await this.audit.record({
      action: AuditAction.BackupRestored,
      organizationId: orgId,
      actorId: actor.id,
      entityType: 'backup',
      entityId: job.id,
      metadata: { created: summary.created, skipped: summary.skipped.length, failed: summary.failed.length, kanbans: summary.kanbans.created, source: job.sourceName ?? '' },
    });
  }

  /**
   * People in the file are matched to existing users by email. Unknown ones are created with the role, status, special access
   * and sign-in password they had on the source server. A file without those fields (format 1) gives an attribution-only
   * placeholder: invited, lowest role, no password. Returns the new id for each file id, and the role of each account created.
   */
  private async resolveUsers(orgId: string, actor: AuthUser, users: BackupUser[], summary: RestoreSummary, job: BackupJob): Promise<{ userMap: Map<string, string>; created: Map<string, string> }> {
    const userMap = new Map<string, string>();
    const created = new Map<string, string>();
    const inOrg = new Map((await this.prisma.user.findMany({ where: { organizationId: orgId }, select: { id: true, email: true } })).map((u) => [u.email.toLowerCase(), u.id]));
    const unmatched = users.filter((u) => !inOrg.has(u.email.toLowerCase()));
    const elsewhere = new Set((await this.prisma.user.findMany({ where: { email: { in: unmatched.map((u) => u.email) } }, select: { email: true } })).map((u) => u.email.toLowerCase()));
    for (const u of users) {
      const have = inOrg.get(u.email.toLowerCase());
      if (have) {
        userMap.set(u.id, have);
        summary.usersMatched += 1;
        continue;
      }
      if (elsewhere.has(u.email.toLowerCase())) {
        this.jobs.warn(job, `${u.name} <${u.email}> belongs to another organization, so their SOPs are attributed to you instead`);
        continue;
      }
      // OWNER is the legacy form of Admin. Only the Owner may create Admin accounts from a file, as with invitations.
      let role = u.orgRole === 'OWNER' ? 'ADMIN' : u.orgRole ?? 'OPERATOR';
      if (role === 'ADMIN' && actor.role !== 'OWNER') {
        role = 'OPERATOR';
        this.jobs.warn(job, `${u.name} <${u.email}> was restored as Viewer: only the Owner can restore Admin accounts`);
      }
      try {
        const person = await this.prisma.user.create({
          data: {
            organizationId: orgId,
            email: u.email,
            name: u.name,
            orgRole: role as OrgRole,
            status: (u.status ?? 'invited') as UserStatus,
            extraPermissions: (u.extraPermissions ?? []).filter((p) => CONFIGURABLE_SET.has(p)),
            passwordHash: u.passwordHash ?? null,
            passwordMustChange: false,
            mfaEnabled: false, // two-factor secrets never leave the source server: each person sets it up again
            lastLoginAt: when(u.lastLoginAt),
            ...(u.createdAt ? { createdAt: new Date(u.createdAt) } : {}),
          },
        });
        userMap.set(u.id, person.id);
        created.set(person.id, role);
        summary.usersCreated += 1;
        if (u.passwordHash) summary.extra.passwordAccounts += 1;
      } catch {
        this.jobs.warn(job, `${u.name} <${u.email}> could not be created, so their SOPs are attributed to ${actor.name}`);
      }
    }
    return { userMap, created };
  }

  /**
   * Groups and their members, matched by name. A non-Admin account left without any group joins General, the rule
   * invitations follow. Returns the restored id for each group in the file.
   */
  private async restoreGroups(orgId: string, groups: BackupGroup[], userMap: Map<string, string>, created: Map<string, string>, summary: RestoreSummary): Promise<Map<string, string>> {
    const groupMap = new Map<string, string>();
    const withGroup = new Set<string>();
    summary.extra.groups.inFile = groups.length;
    for (const g of groups) {
      let row = await this.prisma.userGroup.findUnique({ where: { organizationId_name: { organizationId: orgId, name: g.name } }, select: { id: true } });
      if (!row) {
        row = await this.prisma.userGroup.create({ data: { organizationId: orgId, name: g.name, createdAt: new Date(g.createdAt) }, select: { id: true } });
        summary.extra.groups.created += 1;
      }
      const groupId = row.id;
      groupMap.set(g.id, groupId);
      const members = g.memberIds.map((m) => userMap.get(m)).filter((u): u is string => !!u);
      if (members.length) {
        const written = await this.prisma.groupMember.createMany({ data: members.map((userId) => ({ groupId, userId, organizationId: orgId })), skipDuplicates: true });
        summary.extra.groups.memberships += written.count;
        for (const m of members) withGroup.add(m);
      }
    }
    const orphans = [...created].filter(([id, role]) => role !== 'ADMIN' && !withGroup.has(id)).map(([id]) => id);
    if (orphans.length) {
      const general = await this.prisma.userGroup.upsert({ where: { organizationId_name: { organizationId: orgId, name: 'General' } }, create: { organizationId: orgId, name: 'General' }, update: {} });
      const written = await this.prisma.groupMember.createMany({ data: orphans.map((userId) => ({ groupId: general.id, userId, organizationId: orgId })), skipDuplicates: true });
      summary.extra.groups.memberships += written.count;
    }
    return groupMap;
  }

  /** The organisation settings in the file replace this organisation's. A file without settings leaves them as they are. */
  private async applySettings(orgId: string, s: BackupSettings | null, summary: RestoreSummary): Promise<void> {
    if (!s) return;
    const json = (v: unknown) => (v === null || v === undefined ? Prisma.DbNull : (v as Prisma.InputJsonValue));
    const data = {
      approvalRequired: s.approvalRequired,
      approvalQuorum: s.approvalQuorum,
      allowSelfApproval: s.allowSelfApproval,
      publicSopViewing: s.publicSopViewing,
      rolePermissions: json(s.rolePermissions),
      navConfig: json(s.navConfig),
    };
    await this.prisma.organizationSettings.upsert({ where: { organizationId: orgId }, create: { organizationId: orgId, ...data }, update: data });
    summary.extra.settingsApplied = true;
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
