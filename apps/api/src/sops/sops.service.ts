import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { OrgRole, Prisma, Sop } from '@prisma/client';
import { randomBytes } from 'crypto';
import { AuthUser } from '../common/auth-user';
import { csvCell, parseCsvWithHeader } from '../common/csv';
import { FoldersService } from '../folders/folders.service';
import { hasPermission, Permission } from '../common/permissions';
import { RequestMeta } from '../common/decorators';
import { AuditAction, AuditService } from '../audit/audit.service';
import { MediaService, MediaView } from '../media/media.service';
import { markAttached, reevaluateMedia } from '../media/media-lifecycle';
import { isUniqueViolation, PrismaService, Tx } from '../prisma/prisma.service';
import { sanitizeRichText } from './sanitize';
import { CREATABLE_SOP_TYPES, BulkImportSopsDto, CreateSopDto, ListSopsQuery, SaveStepsDto, SopBulkEditDto, UpdateSopDto, UpdateVersionDto } from './sop.dto';
import { ACTIVE_UNPUBLISHED, recomputeSopStatus, versionLabel } from './sop-status';
import { SopVersionRepository, StepWrite } from './sop-version.repository';

export const SOP_CSV_COLUMNS = ['reference_no', 'name', 'type', 'status', 'folder', 'created_by', 'created_at', 'updated_at'] as const;

type CopyableStep = Prisma.SopStepGetPayload<{ include: { media: true } }>;

export const DEFAULT_CONFIG = {
  cover_sheet: false,
  collaborate: false,
  checklist_sop: false,
  key_points_enabled: false,
  // Advanced options
  language: 'English',
  pdf_orientation: 'Landscape',
  steps_per_page: 6,
  full_image: true,
  step_by_step_pdf: false,
  border_width: '',
  header_footer_color: '#ffffff',
  header_footer_text_color: 'Black',
  red_card_text: '',
  red_bg: '#d40000',
  red_text: 'White',
  green_bg: '#1a9b48',
  green_text: 'White',
  is_critical: false,
  video_link: '',
  total_time_required: '',
};
export type VersionConfig = typeof DEFAULT_CONFIG;

/**
 * Every role may see unpublished (draft) versions — Viewers read drafts too, they just cannot change anything.
 * Kept as a function so call sites stay explicit about the rule.
 */
export function canSeeUnpublished(actor: { permissions: ReadonlySet<Permission> }): boolean {
  return hasPermission(actor, Permission.SopView);
}

const userBrief = { select: { id: true, name: true } } as const;

const versionInclude = {
  steps: {
    orderBy: { order: 'asc' },
    include: {
      media: { orderBy: { displayOrder: 'asc' }, include: { mediaAsset: true } },
      linkedSop: { select: { id: true, name: true, referenceNo: true } },
    },
  },
} satisfies Prisma.SopVersionInclude;

type VersionWithSteps = Prisma.SopVersionGetPayload<{ include: typeof versionInclude }>;

@Injectable()
export class SopsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: SopVersionRepository,
    private readonly media: MediaService,
    private readonly folders: FoldersService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────── queries ─────────────────────────

  /** Tenant- and visibility-scoped SOP lookup; anything else is a 404 (§8). */
  async findSop(actor: AuthUser, sopId: string): Promise<Sop> {
    const sop = await this.prisma.sop.findFirst({
      where: { id: sopId, organizationId: actor.organizationId, deletedAt: null },
    });
    if (!sop) throw new NotFoundException('SOP not found');
    if (!canSeeUnpublished(actor) && (!sop.currentPublishedVersionId || sop.archivedAt)) {
      throw new NotFoundException('SOP not found');
    }
    return sop;
  }

  async list(actor: AuthUser, q: ListSopsQuery) {
    const where: Prisma.SopWhereInput = { organizationId: actor.organizationId, deletedAt: null };
    if (!canSeeUnpublished(actor)) {
      where.currentPublishedVersionId = { not: null };
      where.archivedAt = null;
    }
    if (q.status) where.status = q.status as Prisma.EnumSopStatusFilter['equals'];
    else where.status = { not: 'archived' };
    if (q.folderId === 'root') where.folderId = null;
    else if (q.folderId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q.folderId)) throw new BadRequestException('Invalid folderId');
      where.folderId =
        q.includeSubfolders === 'true' ? { in: await this.folders.descendants(actor.organizationId, q.folderId) } : q.folderId;
    }
    if (q.search?.trim()) {
      const term = q.search.trim();
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { referenceNo: { contains: term, mode: 'insensitive' } },
      ];
    }
    if (q.type) where.type = q.type as Prisma.EnumSopTypeFilter['equals'];
    if (q.createdBy?.trim()) {
      const ids = [...new Set(q.createdBy.split(',').map((s) => s.trim()).filter(Boolean))];
      if (ids.length) where.createdById = { in: ids };
    }
    if (q.checklistOnly === 'true') {
      where.AND = [
        {
          OR: [
            { currentPublishedVersion: { config: { path: ['checklist_sop'], equals: true } } },
            { latestDraftVersion: { config: { path: ['checklist_sop'], equals: true } } },
          ],
        },
      ];
    }
    const SORT: Record<string, Prisma.SopOrderByWithRelationInput> = {
      oldest: { createdAt: 'asc' },
      newest: { createdAt: 'desc' },
      modified: { updatedAt: 'desc' },
      alphabetical: { name: 'asc' },
      reference: { referenceNo: 'asc' },
    };
    const take = q.limit ?? 50;
    const [total, rows, settings, creatorRoster] = await Promise.all([
      this.prisma.sop.count({ where }),
      this.prisma.sop.findMany({
        where,
        orderBy: SORT[q.sort ?? ''] ?? SORT.modified,
        take,
        skip: q.offset ?? 0,
        include: {
          folder: { select: { id: true, name: true } },
          currentPublishedVersion: { select: { id: true, versionSequence: true, publishedAt: true } },
          latestDraftVersion: { select: { id: true, versionSequence: true, lifecycleState: true, currentApprovalRound: true } },
        },
      }),
      this.prisma.organizationSettings.findUniqueOrThrow({ where: { organizationId: actor.organizationId } }),
      this.creatorFacets(actor),
    ]);

    const creators = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.createdById))] }, organizationId: actor.organizationId },
      select: { id: true, name: true },
    });
    const creatorById = new Map(creators.map((c) => [c.id, c]));
    const approvalCounts = await this.approvalCounts(
      rows.map((r) => r.latestDraftVersion).filter((v): v is NonNullable<typeof v> => !!v && v.lifecycleState !== 'DRAFT'),
    );
    const rejected = await this.rejectedDrafts(
      rows.map((r) => r.latestDraftVersion).filter((v): v is NonNullable<typeof v> => !!v && v.lifecycleState === 'DRAFT'),
    );

    const showDrafts = canSeeUnpublished(actor);
    return {
      total,
      facets: { creators: creatorRoster },
      items: rows.map((r) => ({
        id: r.id,
        referenceNo: r.referenceNo,
        name: r.name,
        type: r.type,
        status: r.status,
        folder: r.folder,
        createdAt: r.createdAt,
        createdBy: creatorById.get(r.createdById) ?? null,
        updatedAt: r.updatedAt,
        currentPublishedVersion: r.currentPublishedVersion && {
          ...r.currentPublishedVersion,
          label: versionLabel(r.currentPublishedVersion.versionSequence),
        },
        activeVersion:
          showDrafts && r.latestDraftVersion
            ? {
                id: r.latestDraftVersion.id,
                label: versionLabel(r.latestDraftVersion.versionSequence),
                lifecycleState: r.latestDraftVersion.lifecycleState,
                approvals: approvalCounts.get(r.latestDraftVersion.id) ?? 0,
                quorum: settings.approvalQuorum,
                rejected: rejected.has(r.latestDraftVersion.id),
              }
            : null,
      })),
    };
  }

  /** Full creator roster for the "Created By" filter — independent of the current filters, so the list stays stable. */
  private async creatorFacets(actor: AuthUser): Promise<{ id: string; name: string }[]> {
    const where: Prisma.SopWhereInput = { organizationId: actor.organizationId, deletedAt: null };
    if (!canSeeUnpublished(actor)) {
      where.currentPublishedVersionId = { not: null };
      where.archivedAt = null;
    }
    const rows = await this.prisma.sop.findMany({ where, distinct: ['createdById'], select: { createdById: true } });
    if (!rows.length) return [];
    return this.prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.createdById) }, organizationId: actor.organizationId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  private async approvalCounts(versions: { id: string; currentApprovalRound: number }[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!versions.length) return out;
    const rows = await this.prisma.$queryRaw<{ id: string; n: bigint }[]>`
      SELECT v.id, COUNT(DISTINCT a.approver_id) AS n
      FROM sop_version v
      JOIN sop_version_approval a ON a.sop_version_id = v.id
        AND a.approval_round = v.current_approval_round AND a.decision = 'approved'
      WHERE v.id IN (${Prisma.join(versions.map((v) => Prisma.sql`${v.id}::uuid`))})
      GROUP BY v.id`;
    rows.forEach((r) => out.set(r.id, Number(r.n)));
    return out;
  }

  /** DRAFT versions returned by a rejection in their current round (shown as "Rejected" until resubmitted). */
  private async rejectedDrafts(versions: { id: string; currentApprovalRound: number }[]): Promise<Set<string>> {
    if (!versions.length) return new Set();
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT v.id FROM sop_version v
      JOIN sop_version_approval a ON a.sop_version_id = v.id
        AND a.approval_round = v.current_approval_round AND a.decision = 'rejected'
      WHERE v.id IN (${Prisma.join(versions.map((v) => Prisma.sql`${v.id}::uuid`))})`;
    return new Set(rows.map((r) => r.id));
  }

  async get(actor: AuthUser, sopId: string) {
    const sop = await this.findSop(actor, sopId);
    const showDrafts = canSeeUnpublished(actor);
    const [versions, folder, createdBy] = await Promise.all([
      this.prisma.sopVersion.findMany({
        where: {
          sopId,
          organizationId: actor.organizationId,
          ...(showDrafts ? {} : { lifecycleState: 'PUBLISHED' }),
        },
        orderBy: { versionSequence: 'desc' },
        select: {
          id: true,
          versionSequence: true,
          lifecycleState: true,
          changeSummary: true,
          currentApprovalRound: true,
          createdAt: true,
          createdById: true,
          submittedAt: true,
          approvedAt: true,
          publishedById: true,
          publishedAt: true,
        },
      }),
      sop.folderId ? this.prisma.folder.findFirst({ where: { id: sop.folderId, organizationId: actor.organizationId }, select: { id: true, name: true } }) : null,
      this.prisma.user.findFirst({ where: { id: sop.createdById, organizationId: actor.organizationId }, ...userBrief }),
    ]);
    // names for the "Change History" dialog: who created / published each version
    const authorIds = [...new Set(versions.flatMap((v) => [v.createdById, v.publishedById]).filter((x): x is string => !!x))];
    const authors = new Map(
      (await this.prisma.user.findMany({ where: { id: { in: authorIds }, organizationId: actor.organizationId }, select: { id: true, name: true } })).map((u) => [u.id, u.name]),
    );
    return {
      id: sop.id,
      referenceNo: sop.referenceNo,
      name: sop.name,
      type: sop.type,
      status: sop.status,
      folder,
      createdAt: sop.createdAt,
      createdBy,
      updatedAt: sop.updatedAt,
      archivedAt: sop.archivedAt,
      currentPublishedVersionId: sop.currentPublishedVersionId,
      activeVersionId: showDrafts ? sop.latestDraftVersionId : null,
      qrPublicToken: sop.qrPublicToken,
      versions: versions.map(({ publishedById, ...v }) => ({
        ...v,
        label: versionLabel(v.versionSequence),
        createdByName: authors.get(v.createdById) ?? null,
        publishedByName: publishedById ? (authors.get(publishedById) ?? null) : null,
      })),
    };
  }

  async getVersion(actor: AuthUser, sopId: string, versionId: string) {
    await this.findSop(actor, sopId);
    const v = await this.prisma.sopVersion.findFirst({
      where: { id: versionId, sopId, organizationId: actor.organizationId },
      include: versionInclude,
    });
    if (!v || (v.lifecycleState !== 'PUBLISHED' && !canSeeUnpublished(actor))) {
      throw new NotFoundException('Version not found');
    }
    return this.versionView(v);
  }

  async getCurrent(actor: AuthUser, sopId: string) {
    const sop = await this.findSop(actor, sopId);
    if (!sop.currentPublishedVersionId) throw new NotFoundException('SOP has no published version');
    return this.getVersion(actor, sopId, sop.currentPublishedVersionId);
  }

  /** Loads a version for rendering (PDF/public viewer) without actor checks — callers must scope first. */
  async loadVersionForRender(organizationId: string, versionId: string): Promise<VersionWithSteps> {
    return this.prisma.sopVersion.findFirstOrThrow({ where: { id: versionId, organizationId }, include: versionInclude });
  }

  async versionView(v: VersionWithSteps) {
    const users = await this.prisma.user.findMany({
      where: { id: { in: [v.createdById, v.submittedById, v.publishedById].filter((x): x is string => !!x) } },
      select: { id: true, name: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    const steps = await Promise.all(
      v.steps.map(async (s) => ({
        id: s.id,
        order: s.order,
        title: s.title,
        description: s.description,
        isTextOnly: s.isTextOnly,
        isCritical: s.isCritical,
        usesOkNotokMedia: s.usesOkNotokMedia,
        plannedTimeSeconds: s.plannedTimeSeconds,
        linkedSop: s.linkedSop,
        linkedSopVersionId: s.linkedSopVersionId,
        media: await Promise.all(s.media.map(async (m): Promise<MediaView & { displayOrder: number }> => ({ ...(await this.media.view(m.mediaAsset)), displayOrder: m.displayOrder }))),
      })),
    );
    return {
      id: v.id,
      sopId: v.sopId,
      versionSequence: v.versionSequence,
      label: versionLabel(v.versionSequence),
      lifecycleState: v.lifecycleState,
      config: { ...DEFAULT_CONFIG, ...(v.config as Partial<VersionConfig>) },
      changeSummary: v.changeSummary,
      currentApprovalRound: v.currentApprovalRound,
      createdAt: v.createdAt,
      createdBy: byId.get(v.createdById) ?? null,
      submittedAt: v.submittedAt,
      submittedBy: v.submittedById ? byId.get(v.submittedById) ?? null : null,
      approvedAt: v.approvedAt,
      publishedAt: v.publishedAt,
      publishedBy: v.publishedById ? byId.get(v.publishedById) ?? null : null,
      cycleTimeSeconds: v.steps.reduce((sum, s) => sum + s.plannedTimeSeconds, 0),
      steps,
    };
  }

  // ───────────────────────── commands ─────────────────────────

  /** `seedVersionId`: copy that version's config and steps into the new SOP's first draft (Duplicate). */
  async create(actor: AuthUser, dto: CreateSopDto, seedVersionId?: string) {
    if (dto.folderId) await this.assertFolder(actor, dto.folderId);
    for (let attempt = 0; attempt < 5; attempt++) {
      const referenceNo = dto.referenceNo?.trim() || (await this.nextReferenceNo(actor.organizationId, attempt));
      try {
        const sop = await this.prisma.$transaction(async (tx) => {
          const sop = await tx.sop.create({
            data: {
              organizationId: actor.organizationId,
              referenceNo,
              name: dto.name.trim(),
              type: dto.type ?? 'standard',
              folderId: dto.folderId ?? null,
              qrPublicToken: randomBytes(18).toString('base64url'),
              createdById: actor.id,
            },
          });
          const seed = seedVersionId
            ? await tx.sopVersion.findUniqueOrThrow({ where: { id: seedVersionId }, include: { steps: { include: { media: true } } } })
            : null;
          const v = await tx.sopVersion.create({
            data: {
              organizationId: actor.organizationId,
              sopId: sop.id,
              versionSequence: 1,
              config: (seed?.config as Prisma.InputJsonValue) ?? DEFAULT_CONFIG,
              createdById: actor.id,
            },
          });
          if (seed) await markAttached(tx, await this.copySteps(tx, actor.organizationId, seed.steps, v.id));
          await recomputeSopStatus(tx, sop.id);
          return sop;
        });
        return this.get(actor, sop.id);
      } catch (e) {
        if (isUniqueViolation(e) && !dto.referenceNo) continue; // auto-number race: retry
        if (isUniqueViolation(e)) throw new ConflictException('Reference number already in use');
        throw e;
      }
    }
    throw new ConflictException('Could not allocate a reference number');
  }

  /** Copies an SOP's newest content (open draft, else the published version) into a new SOP. */
  async duplicate(actor: AuthUser, sopId: string) {
    const src = await this.findSop(actor, sopId);
    const seed = (canSeeUnpublished(actor) && src.latestDraftVersionId) || src.currentPublishedVersionId;
    if (!seed) throw new BadRequestException('This SOP has no content to duplicate');
    const name = `${src.name} (Copy)`.slice(0, 300);
    return this.create(actor, { name, type: src.type as CreateSopDto['type'], folderId: src.folderId ?? undefined }, seed);
  }

  private async copySteps(tx: Tx, organizationId: string, steps: CopyableStep[], toVersionId: string): Promise<string[]> {
    const assetIds: string[] = [];
    for (const s of steps) {
      const step = await tx.sopStep.create({
        data: {
          organizationId,
          sopVersionId: toVersionId,
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
      if (s.media.length) {
        await tx.sopStepMedia.createMany({
          data: s.media.map((m) => ({ sopStepId: step.id, mediaAssetId: m.mediaAssetId, displayOrder: m.displayOrder })),
        });
        assetIds.push(...s.media.map((m) => m.mediaAssetId));
      }
    }
    return assetIds;
  }

  private async nextReferenceNo(organizationId: string, bump: number): Promise<string> {
    const n = (await this.prisma.sop.count({ where: { organizationId } })) + 1 + bump;
    return `SOP-${String(n).padStart(4, '0')}`;
  }

  private async assertFolder(actor: AuthUser, folderId: string) {
    const f = await this.prisma.folder.findFirst({ where: { id: folderId, organizationId: actor.organizationId, deletedAt: null } });
    if (!f) throw new BadRequestException('Folder not found');
  }

  async updateSop(actor: AuthUser, sopId: string, dto: UpdateSopDto) {
    const existing = await this.findSop(actor, sopId);
    if (dto.type && !['standard', 'advanced'].includes(existing.type)) {
      throw new BadRequestException('The type of a video or document SOP cannot be changed');
    }
    if (dto.folderId) await this.assertFolder(actor, dto.folderId);
    try {
      await this.prisma.sop.update({
        where: { id: sopId },
        data: {
          name: dto.name?.trim(),
          type: dto.type,
          referenceNo: dto.referenceNo?.trim(),
          folderId: dto.folderId === undefined ? undefined : dto.folderId,
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('Reference number already in use');
      throw e;
    }
    return this.get(actor, sopId);
  }

  /**
   * Archiving changes the effective published/live state, so it requires publish authority (not just edit).
   * Audited separately from ordinary edits.
   */
  async setArchived(actor: AuthUser, sopId: string, archived: boolean, meta: RequestMeta) {
    if (!hasPermission(actor, Permission.SopPublish)) throw new ForbiddenException('Archiving changes what is live and requires publish permission');
    await this.findSop(actor, sopId);
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.sop.findUniqueOrThrow({ where: { id: sopId }, select: { archivedAt: true } });
      await tx.sop.update({ where: { id: sopId }, data: { archivedAt: archived ? new Date() : null } });
      await recomputeSopStatus(tx, sopId);
      await this.audit.record(
        { action: AuditAction.SopArchived, organizationId: actor.organizationId, actorId: actor.id, entityType: 'sop', entityId: sopId, metadata: { archived, previouslyArchived: !!before.archivedAt }, ...meta },
        tx,
      );
    });
    return this.get(actor, sopId);
  }

  /** Bulk move-to-folder and/or archive/unarchive for a selection of SOPs. */
  async bulkEdit(actor: AuthUser, dto: SopBulkEditDto, meta: RequestMeta) {
    const ids = [...new Set(dto.ids)];
    const { patch } = dto;
    if (patch.folderId === undefined && patch.archived === undefined) throw new BadRequestException('Nothing to update');
    if (patch.archived !== undefined && !hasPermission(actor, Permission.SopPublish)) {
      throw new ForbiddenException('Archiving changes what is live and requires publish permission');
    }
    if (patch.folderId) await this.assertFolder(actor, patch.folderId);
    return this.prisma.$transaction(async (tx) => {
      const owned = await tx.sop.count({ where: { id: { in: ids }, organizationId: actor.organizationId, deletedAt: null } });
      if (owned !== ids.length) throw new NotFoundException('One or more SOPs not found');
      if (patch.folderId !== undefined) {
        await tx.sop.updateMany({ where: { id: { in: ids } }, data: { folderId: patch.folderId } });
      }
      if (patch.archived !== undefined) {
        await tx.sop.updateMany({ where: { id: { in: ids } }, data: { archivedAt: patch.archived ? new Date() : null } });
        for (const id of ids) await recomputeSopStatus(tx, id);
        await this.audit.record(
          { action: AuditAction.SopArchived, organizationId: actor.organizationId, actorId: actor.id, entityType: 'sop', metadata: { bulk: true, archived: patch.archived, count: ids.length }, ...meta },
          tx,
        );
      }
      return { updated: ids.length };
    });
  }

  /**
   * Copy-on-write (Invariant #4): a new DRAFT seeded from the current published
   * version. Invariant #19 is enforced by the partial unique index — a
   * concurrent second request fails cleanly with 409.
   */
  async createNewVersion(actor: AuthUser, sopId: string) {
    const sop = await this.findSop(actor, sopId);
    if (sop.archivedAt) throw new BadRequestException('Unarchive the SOP before editing it');
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        const base = sop.currentPublishedVersionId
          ? await tx.sopVersion.findUniqueOrThrow({ where: { id: sop.currentPublishedVersionId }, include: { steps: { include: { media: true } } } })
          : null;
        const max = await tx.sopVersion.aggregate({ where: { sopId }, _max: { versionSequence: true } });
        const v = await tx.sopVersion.create({
          data: {
            organizationId: actor.organizationId,
            sopId,
            versionSequence: (max._max.versionSequence ?? 0) + 1,
            config: (base?.config as Prisma.InputJsonValue) ?? DEFAULT_CONFIG,
            createdById: actor.id,
          },
        });
        await markAttached(tx, await this.copySteps(tx, actor.organizationId, base?.steps ?? [], v.id));
        await recomputeSopStatus(tx, sopId);
        return v.id;
      });
      return this.getVersion(actor, sopId, id);
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('An active (unpublished) version already exists for this SOP');
      throw e;
    }
  }

  async updateVersion(actor: AuthUser, sopId: string, versionId: string, dto: UpdateVersionDto) {
    await this.findSop(actor, sopId);
    await this.prisma.$transaction(async (tx) => {
      const v = await this.repo.lockDraft(tx, actor.organizationId, sopId, versionId);
      const current = await tx.sopVersion.findUniqueOrThrow({ where: { id: versionId }, select: { config: true } });
      await this.repo.updateDraftFields(tx, v, {
        config: dto.config ? { ...DEFAULT_CONFIG, ...(current.config as object), ...dto.config } : undefined,
        changeSummary: dto.changeSummary,
      });
      await tx.sop.update({ where: { id: sopId }, data: { updatedAt: new Date() } });
    });
    return this.getVersion(actor, sopId, versionId);
  }

  async saveSteps(actor: AuthUser, sopId: string, versionId: string, dto: SaveStepsDto) {
    await this.findSop(actor, sopId);
    const allMedia = dto.steps.flatMap((s) => (s.media ?? []).map((m) => m.mediaAssetId));
    await this.media.assertUsable(actor.organizationId, allMedia);
    await this.assertLinks(actor, sopId, dto);

    await this.prisma.$transaction(async (tx) => {
      const v = await this.repo.lockDraft(tx, actor.organizationId, sopId, versionId);
      const writes: StepWrite[] = dto.steps.map((s, i) => ({
        id: s.id,
        order: i + 1,
        title: s.title?.trim() || null,
        description: sanitizeRichText(s.description),
        isTextOnly: s.isTextOnly ?? false,
        isCritical: s.isCritical ?? false,
        usesOkNotokMedia: s.usesOkNotokMedia ?? false,
        plannedTimeSeconds: s.plannedTimeSeconds ?? 0,
        linkedSopId: s.linkedSopId ?? null,
        linkedSopVersionId: s.linkedSopVersionId ?? null,
        mediaAssetIds: [...new Set((s.media ?? []).map((m) => m.mediaAssetId))],
      }));
      const { before, after } = await this.repo.replaceSteps(tx, v, writes);
      await markAttached(tx, after);
      const afterSet = new Set(after);
      await reevaluateMedia(tx, before.filter((id) => !afterSet.has(id)));
      await tx.sop.update({ where: { id: sopId }, data: { updatedAt: new Date() } });
    });
    return this.getVersion(actor, sopId, versionId);
  }

  private async assertLinks(actor: AuthUser, sopId: string, dto: SaveStepsDto) {
    const linkedSopIds = [...new Set(dto.steps.map((s) => s.linkedSopId).filter((x): x is string => !!x))];
    if (linkedSopIds.includes(sopId)) throw new BadRequestException('A step cannot link to its own SOP');
    if (linkedSopIds.length) {
      const n = await this.prisma.sop.count({ where: { id: { in: linkedSopIds }, organizationId: actor.organizationId, deletedAt: null } });
      if (n !== linkedSopIds.length) throw new BadRequestException('Linked SOP not found');
    }
    for (const s of dto.steps) {
      if (!s.linkedSopVersionId) continue;
      if (!s.linkedSopId) throw new BadRequestException('linkedSopVersionId requires linkedSopId');
      const lv = await this.prisma.sopVersion.findFirst({
        where: { id: s.linkedSopVersionId, sopId: s.linkedSopId, organizationId: actor.organizationId, lifecycleState: 'PUBLISHED' },
      });
      if (!lv) throw new BadRequestException('Linked SOP version must be a published version of the linked SOP');
    }
  }

  /** Author discards an active unpublished version, freeing the SOP for a new one (§6.3). */
  async abandonVersion(actor: AuthUser, sopId: string, versionId: string) {
    await this.findSop(actor, sopId);
    await this.prisma.$transaction(async (tx) => {
      const v = await this.repo.lock(tx, actor.organizationId, sopId, versionId);
      if (!ACTIVE_UNPUBLISHED.includes(v.lifecycleState)) {
        throw new ConflictException(`A ${v.lifecycleState} version cannot be abandoned`);
      }
      await tx.sopVersion.update({ where: { id: versionId }, data: { lifecycleState: 'ABANDONED' } });
      const media = await tx.sopStepMedia.findMany({ where: { sopStep: { sopVersionId: versionId } }, select: { mediaAssetId: true } });
      await reevaluateMedia(tx, media.map((m) => m.mediaAssetId));
      await recomputeSopStatus(tx, sopId);
    });
    return this.get(actor, sopId);
  }

  /**
   * Deletes an SOP that is still in draft / not yet finished (e.g. an unwanted duplicate): it must have an
   * unpublished version in progress, or never have been published. Open versions are abandoned so their media can
   * be released. A fully published SOP with nothing in progress must be archived instead.
   */
  async deleteSop(actor: AuthUser, sopId: string) {
    await this.findSop(actor, sopId);
    await this.prisma.$transaction(async (tx) => {
      // lock the SOP row so a concurrent publish cannot slip in between the check and the delete
      await tx.$queryRaw`SELECT id FROM sop WHERE id = ${sopId}::uuid FOR UPDATE`;
      const published = await tx.sopVersion.count({ where: { sopId, lifecycleState: 'PUBLISHED' } });
      const open = await tx.sopVersion.findMany({ where: { sopId, lifecycleState: { in: ACTIVE_UNPUBLISHED } }, select: { id: true } });
      if (published && !open.length) throw new ConflictException('A published SOP cannot be deleted; archive it instead');
      for (const v of open) await this.repo.lock(tx, actor.organizationId, sopId, v.id);
      await tx.sopVersion.updateMany({ where: { id: { in: open.map((v) => v.id) } }, data: { lifecycleState: 'ABANDONED' } });
      const media = await tx.sopStepMedia.findMany({ where: { sopStep: { sopVersionId: { in: open.map((v) => v.id) } } }, select: { mediaAssetId: true } });
      await reevaluateMedia(tx, media.map((m) => m.mediaAssetId));
      await recomputeSopStatus(tx, sopId);
      await tx.sop.update({ where: { id: sopId }, data: { deletedAt: new Date() } });
    });
  }

  /** Shared by workflow services. */
  recompute(tx: Tx, sopId: string) {
    return recomputeSopStatus(tx, sopId);
  }

  // ───────────────────────── bulk import / export ─────────────────────────

  async exportCsv(actor: AuthUser): Promise<string> {
    const where: Prisma.SopWhereInput = { organizationId: actor.organizationId, deletedAt: null };
    if (!canSeeUnpublished(actor)) {
      where.currentPublishedVersionId = { not: null };
      where.archivedAt = null;
    }
    const rows = await this.prisma.sop.findMany({
      where,
      orderBy: { referenceNo: 'asc' },
      include: { folder: { select: { name: true } } },
    });
    const creators = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.createdById))] }, organizationId: actor.organizationId },
      select: { id: true, name: true },
    });
    const creatorById = new Map(creators.map((c) => [c.id, c.name]));
    const line = (r: (typeof rows)[number]) =>
      [r.referenceNo, r.name, r.type, r.status, r.folder?.name, creatorById.get(r.createdById), r.createdAt.toISOString(), r.updatedAt.toISOString()]
        .map(csvCell)
        .join(',');
    return [SOP_CSV_COLUMNS.join(','), ...rows.map(line)].join('\r\n') + '\r\n';
  }

  /**
   * All-or-nothing CSV import: creates new SOPs (empty first draft, no steps) from name/reference/type/folder
   * columns. Every row is validated first; nothing is written unless every row is valid. `dryRun` validates only.
   */
  async bulkImportCsv(actor: AuthUser, dto: BulkImportSopsDto) {
    const rows = parseCsvWithHeader(dto.csv);
    if (!rows.length) throw new BadRequestException('CSV has no data rows');
    if (rows.length > 500) throw new BadRequestException('At most 500 rows per import');
    if (!rows[0] || !('name' in rows[0].values)) throw new BadRequestException('CSV must include a "name" column');

    const folders = await this.prisma.folder.findMany({ where: { organizationId: actor.organizationId, deletedAt: null }, select: { id: true, name: true } });
    const folderByName = new Map(folders.map((f) => [f.name.trim().toLowerCase(), f.id]));

    const refs = rows.map((r) => r.values.reference_no?.trim()).filter((r): r is string => !!r);
    const dupeRefs = refs.filter((r, i) => refs.indexOf(r) !== i);
    const existing = refs.length
      ? await this.prisma.sop.findMany({ where: { organizationId: actor.organizationId, referenceNo: { in: refs } }, select: { referenceNo: true } })
      : [];
    const takenRefs = new Set(existing.map((s) => s.referenceNo));

    const errors: { row: number; error: string }[] = [];
    const data: { name: string; referenceNo?: string; type: 'standard' | 'advanced'; folderId: string | null }[] = [];
    for (const { row, values: v } of rows) {
      try {
        if (!v.name) throw new Error('name is required');
        if (v.name.length > 300) throw new Error('name is too long (max 300)');
        const referenceNo = v.reference_no?.trim() || undefined;
        if (referenceNo) {
          if (referenceNo.length > 60) throw new Error('reference_no is too long (max 60)');
          if (takenRefs.has(referenceNo)) throw new Error(`Reference number "${referenceNo}" is already in use`);
          if (dupeRefs.includes(referenceNo)) throw new Error(`Reference number "${referenceNo}" is duplicated in this file`);
        }
        const type = (v.type?.trim().toLowerCase() || 'standard') as 'standard' | 'advanced';
        if (!CREATABLE_SOP_TYPES.includes(type)) throw new Error('type must be standard or advanced');
        let folderId: string | null = null;
        if (v.folder?.trim()) {
          const found = folderByName.get(v.folder.trim().toLowerCase());
          if (!found) throw new Error(`Folder "${v.folder.trim()}" not found`);
          folderId = found;
        }
        data.push({ name: v.name.trim(), referenceNo, type, folderId });
      } catch (e) {
        errors.push({ row, error: (e as Error).message });
      }
    }
    if (errors.length || dto.dryRun) return { imported: 0, valid: data.length, errors };

    try {
      const imported = await this.prisma.$transaction(async (tx) => {
        let autoBump = await tx.sop.count({ where: { organizationId: actor.organizationId } });
        for (const row of data) {
          let referenceNo = row.referenceNo;
          if (!referenceNo) {
            autoBump += 1;
            referenceNo = `SOP-${String(autoBump).padStart(4, '0')}`;
          }
          const sop = await tx.sop.create({
            data: {
              organizationId: actor.organizationId,
              referenceNo,
              name: row.name,
              type: row.type,
              folderId: row.folderId,
              qrPublicToken: randomBytes(18).toString('base64url'),
              createdById: actor.id,
            },
          });
          await tx.sopVersion.create({
            data: { organizationId: actor.organizationId, sopId: sop.id, versionSequence: 1, config: DEFAULT_CONFIG, createdById: actor.id },
          });
          await recomputeSopStatus(tx, sop.id);
        }
        return data.length;
      });
      return { imported, valid: data.length, errors };
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('A reference number collided during import; please retry');
      throw e;
    }
  }
}
