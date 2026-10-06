import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import QRCode from 'qrcode';
import { env } from '../config/env';
import { BRAND } from '../pdf/brand';
import { Kanban, KanbanOrderingType, KanbanRevision, KanbanRevisionState, Prisma } from '@prisma/client';
import { AuditAction, AuditActionName, AuditService } from '../audit/audit.service';
import { ApprovalPool, PoolMember } from '../approvals/approval-pool';
import { AuthUser } from '../common/auth-user';
import { csvCell, parseCsvWithHeader } from '../common/csv';
import { RequestMeta } from '../common/decorators';
import { isFullAccessRole, Permission } from '../common/permissions';
import { MediaService } from '../media/media.service';
import { markAttached, reevaluateMedia } from '../media/media-lifecycle';
import { PdfRendererService } from '../pdf/pdf-renderer.service';
import { isUniqueViolation, PrismaService, Tx } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { eligibility, DENIAL_MESSAGES } from './kanban-eligibility';
import { kanbanPrintHtml, PrintableKanban } from './kanban-print';
import {
  assertTransition,
  blockedStage,
  canTransition,
  OPEN_REVISION_STATES,
  PENDING_REVISION_STATES,
  requiredPermission,
  RevisionAction,
  targetState,
} from './kanban-revision';
import { BulkEditDto, CreateKanbanDto, ListKanbansQuery, UpdateKanbanDto } from './kanban.dto';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type RevisionActionName = 'submit' | 'preApprove' | 'approve' | 'reject' | 'publish';
export type RevisionActionFlags = Record<RevisionActionName, boolean>;

/** The open revision shown on a card in the list and detail. */
export interface OpenRevisionSummary {
  id: string;
  state: KanbanRevisionState;
  comment: string | null;
  submitter: { id: string; name: string | null } | null;
}

const kanbanInclude = {
  picture: true,
  media: { include: { mediaAsset: true } },
  orderingSop: { select: { id: true, name: true, referenceNo: true } },
} satisfies Prisma.KanbanInclude;
type KanbanFull = Prisma.KanbanGetPayload<{ include: typeof kanbanInclude }>;

/** Column order for CSV import/export. */
export const KANBAN_CSV_COLUMNS = [
  'part_code', 'part_description', 'supplier', 'supplier_part_no', 'used_for', 'order_when', 'order_qty',
  'delivery_time', 'location', 'price', 'carriage', 'custom_field_1', 'custom_field_2', 'ordering_type',
  'ordering_url', 'ordering_sop_ref', 'ordering_email', 'tag', 'color', 'barcode', 'template',
] as const;

interface Ordering {
  orderingType: KanbanOrderingType;
  orderingUrl: string | null;
  orderingSopId: string | null;
  orderingEmail: string | null;
}

/**
 * A revision's proposed card. Stored as JSON on the revision so the live `kanban` row is never touched until publish.
 * Field names match the kanban columns; publish copies them across.
 */
export interface KanbanPayload extends Ordering {
  partCode: string;
  partDescription: string | null;
  supplier: string | null;
  supplierPartNo: string | null;
  usedFor: string | null;
  orderWhen: string | null;
  orderQty: string | null;
  deliveryTime: string | null;
  location: string | null;
  price: number | null;
  carriage: number | null;
  customField1: string | null;
  customField2: string | null;
  tag: string | null;
  color: string | null;
  barcode: string | null;
  template: string;
  pictureAssetId: string | null;
  mediaAssetIds: string[];
}

/** Revision states that are "in review" and therefore may not be edited. */
const LOCKED_FOR_EDIT: KanbanRevisionState[] = PENDING_REVISION_STATES;

@Injectable()
export class KanbansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly renderer: PdfRendererService,
    private readonly pool: ApprovalPool,
  ) {}

  // ───────────── live queries (published content only) ─────────────

  async list(actor: AuthUser, q: ListKanbansQuery) {
    const where: Prisma.KanbanWhereInput = { organizationId: actor.organizationId, deletedAt: null };
    if (q.tag) where.tag = q.tag;
    if (q.supplier) where.supplier = q.supplier;
    if (q.location) where.location = q.location;
    if (q.search?.trim()) {
      const contains = { contains: q.search.trim(), mode: 'insensitive' as const };
      where.OR = [
        { partCode: contains },
        { partDescription: contains },
        { supplier: contains },
        { supplierPartNo: contains },
        { usedFor: contains },
        { tag: contains },
        { barcode: contains },
      ];
    }
    const [total, rows, facets] = await Promise.all([
      this.prisma.kanban.count({ where }),
      this.prisma.kanban.findMany({
        where,
        include: kanbanInclude,
        orderBy: [{ [q.sort ?? 'partCode']: q.dir ?? 'asc' }, { id: 'asc' }],
        take: q.limit ?? 100,
        skip: q.offset ?? 0,
      }),
      this.facets(actor.organizationId),
    ]);
    const [names, open] = await Promise.all([this.creatorNames(rows.map((r) => r.createdById)), this.openRevisions(actor.organizationId, rows.map((r) => r.id))]);
    const items = await Promise.all(rows.map(async (r) => ({ ...(await this.view(r, names)), openRevision: open.get(r.id) ?? null })));
    return { total, facets, items };
  }

  /** Kanban.createdById has no Prisma relation, so creator names are looked up in one query. */
  private async creatorNames(ids: string[]) {
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private async facets(organizationId: string) {
    const base = { organizationId, deletedAt: null };
    const [tags, suppliers, locations] = await Promise.all([
      this.prisma.kanban.findMany({ where: { ...base, tag: { not: null } }, distinct: ['tag'], select: { tag: true }, orderBy: { tag: 'asc' } }),
      this.prisma.kanban.findMany({ where: { ...base, supplier: { not: null } }, distinct: ['supplier'], select: { supplier: true }, orderBy: { supplier: 'asc' } }),
      this.prisma.kanban.findMany({ where: { ...base, location: { not: null } }, distinct: ['location'], select: { location: true }, orderBy: { location: 'asc' } }),
    ]);
    return {
      tags: tags.map((t) => t.tag!),
      suppliers: suppliers.map((t) => t.supplier!),
      locations: locations.map((t) => t.location!),
    };
  }

  private async find(actor: AuthUser, id: string): Promise<KanbanFull> {
    const k = await this.prisma.kanban.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null }, include: kanbanInclude });
    if (!k) throw new NotFoundException('Kanban not found');
    return k;
  }

  async get(actor: AuthUser, id: string) {
    const k = await this.find(actor, id);
    const [names, open] = await Promise.all([this.creatorNames([k.createdById]), this.openRevisions(actor.organizationId, [k.id])]);
    return { ...(await this.view(k, names)), openRevision: open.get(k.id) ?? null };
  }

  /**
   * The open revision (if any) of each card, for the card list and detail. Only the review state is exposed here;
   * the proposed fields stay behind GET /kanbans/revisions/:rid, which applies the reviewer visibility rules.
   */
  private async openRevisions(organizationId: string, kanbanIds: string[]) {
    const out = new Map<string, OpenRevisionSummary>();
    if (kanbanIds.length === 0) return out;
    const rows = await this.prisma.kanbanRevision.findMany({
      where: { organizationId, kanbanId: { in: kanbanIds }, state: { in: OPEN_REVISION_STATES } },
    });
    const names = await this.creatorNames(rows.map((r) => r.submittedById).filter((x): x is string => !!x));
    for (const r of rows) {
      if (!r.kanbanId) continue;
      out.set(r.kanbanId, {
        id: r.id,
        state: r.state,
        comment: r.lastComment,
        submitter: r.submittedById ? { id: r.submittedById, name: names.get(r.submittedById) ?? null } : null,
      });
    }
    return out;
  }

  /**
   * Change history of one live card, newest first, built from the audit trail of its revisions and direct actions.
   * Replaces the old activity-event history, which described live writes that no longer exist.
   */
  async history(actor: AuthUser, id: string) {
    await this.find(actor, id);
    const revisionIds = (await this.prisma.kanbanRevision.findMany({ where: { organizationId: actor.organizationId, kanbanId: id }, select: { id: true } })).map((r) => r.id);
    const events = await this.prisma.auditLog.findMany({
      where: {
        organizationId: actor.organizationId,
        OR: [
          { entityType: 'kanban_revision', entityId: { in: revisionIds } },
          { entityType: 'kanban', entityId: id },
        ],
      },
      orderBy: { occurredAt: 'desc' },
      take: 200,
    });
    const names = await this.creatorNames(events.map((e) => e.actorId).filter((x): x is string => !!x));
    return events.map((e) => ({
      id: e.id,
      action: HISTORY_LABELS[e.action] ?? e.action,
      at: e.occurredAt,
      by: e.actorId ? (names.get(e.actorId) ?? null) : null,
    }));
  }

  private async view(k: KanbanFull, names?: Map<string, string>) {
    const { picture, media, organizationId: _org, ...rest } = k;
    const name = names?.get(k.createdById);
    return {
      ...rest,
      createdBy: name ? { id: k.createdById, name } : null,
      price: k.price === null ? null : Number(k.price),
      carriage: k.carriage === null ? null : Number(k.carriage),
      picture: picture && picture.lifecycleState !== 'purged' ? await this.media.view(picture) : null,
      media: await Promise.all(media.map((m) => this.media.view(m.mediaAsset))),
    };
  }

  // ───────────── validation ─────────────

  /**
   * §6.7: the ordering target must match ordering_type — validated before the DB CHECK fires. The URL is optional
   * (a card may have no ordering link yet); SOP and email targets are required for their types.
   */
  private async ordering(actor: AuthUser, input: Partial<Ordering> & { orderingType?: KanbanOrderingType }): Promise<Ordering> {
    const type = input.orderingType;
    if (!type) throw new BadRequestException('orderingType is required');
    if (type === 'url') {
      const url = input.orderingUrl?.trim() || null;
      if (url && !/^https?:\/\/\S+$/i.test(url)) throw new BadRequestException('The ordering URL must be a valid http(s) link');
      return { orderingType: type, orderingUrl: url, orderingSopId: null, orderingEmail: null };
    }
    if (type === 'email') {
      const email = input.orderingEmail?.trim().toLowerCase();
      if (!email || !EMAIL_RE.test(email)) throw new BadRequestException('A valid ordering email is required');
      return { orderingType: type, orderingUrl: null, orderingSopId: null, orderingEmail: email };
    }
    if (!input.orderingSopId) throw new BadRequestException('orderingSopId is required when orderingType is "sop"');
    const sop = await this.prisma.sop.findFirst({ where: { id: input.orderingSopId, organizationId: actor.organizationId, deletedAt: null } });
    if (!sop) throw new BadRequestException('Ordering SOP not found');
    return { orderingType: type, orderingUrl: null, orderingSopId: sop.id, orderingEmail: null };
  }

  /** Field values present on a DTO; absent fields are undefined so they keep their previous value. */
  private fields(dto: CreateKanbanDto | UpdateKanbanDto) {
    const t = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);
    return {
      partDescription: t(dto.partDescription),
      supplier: t(dto.supplier),
      supplierPartNo: t(dto.supplierPartNo),
      usedFor: t(dto.usedFor),
      orderWhen: t(dto.orderWhen),
      orderQty: t(dto.orderQty),
      deliveryTime: t(dto.deliveryTime),
      location: t(dto.location),
      price: dto.price === undefined ? undefined : dto.price,
      carriage: dto.carriage === undefined ? undefined : dto.carriage,
      customField1: t(dto.customField1),
      customField2: t(dto.customField2),
      tag: t(dto.tag),
      color: t(dto.color),
      barcode: t(dto.barcode),
      template: dto.template,
    };
  }

  /** Live card → payload, so an edit starts from what is published. */
  private payloadFromLive(k: KanbanFull): KanbanPayload {
    return {
      partCode: k.partCode,
      partDescription: k.partDescription,
      supplier: k.supplier,
      supplierPartNo: k.supplierPartNo,
      usedFor: k.usedFor,
      orderWhen: k.orderWhen,
      orderQty: k.orderQty,
      deliveryTime: k.deliveryTime,
      location: k.location,
      price: k.price === null ? null : Number(k.price),
      carriage: k.carriage === null ? null : Number(k.carriage),
      customField1: k.customField1,
      customField2: k.customField2,
      tag: k.tag,
      color: k.color,
      barcode: k.barcode,
      template: k.template,
      orderingType: k.orderingType,
      orderingUrl: k.orderingUrl,
      orderingSopId: k.orderingSopId,
      orderingEmail: k.orderingEmail,
      pictureAssetId: k.pictureAssetId,
      mediaAssetIds: k.media.map((m) => m.mediaAssetId),
    };
  }

  private assetIds(p: KanbanPayload): string[] {
    return [p.pictureAssetId, ...p.mediaAssetIds].filter((x): x is string => !!x);
  }

  /** Applies a DTO onto a payload. Ordering is re-validated whenever it is touched. */
  private async merge(actor: AuthUser, base: KanbanPayload, dto: CreateKanbanDto | UpdateKanbanDto): Promise<KanbanPayload> {
    const next: KanbanPayload = { ...base };
    for (const [key, value] of Object.entries(this.fields(dto))) {
      if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value;
    }
    if ('partCode' in dto && dto.partCode !== undefined) next.partCode = dto.partCode.trim();
    if (dto.pictureAssetId !== undefined) next.pictureAssetId = dto.pictureAssetId ?? null;
    if (dto.mediaAssetIds !== undefined) next.mediaAssetIds = [...new Set(dto.mediaAssetIds)];
    const orderingTouched = dto.orderingType !== undefined || dto.orderingUrl !== undefined || dto.orderingSopId !== undefined || dto.orderingEmail !== undefined;
    if (orderingTouched) {
      Object.assign(
        next,
        await this.ordering(actor, {
          orderingType: dto.orderingType ?? base.orderingType,
          orderingUrl: dto.orderingUrl !== undefined ? dto.orderingUrl : base.orderingUrl,
          orderingSopId: dto.orderingSopId !== undefined ? dto.orderingSopId : base.orderingSopId,
          orderingEmail: dto.orderingEmail !== undefined ? dto.orderingEmail : base.orderingEmail,
        }),
      );
    }
    return next;
  }

  private async syncMedia(tx: Tx, kanbanId: string, before: string[], mediaIds: string[] | undefined) {
    if (mediaIds !== undefined) {
      await tx.kanbanMedia.deleteMany({ where: { kanbanId } });
      if (mediaIds.length) await tx.kanbanMedia.createMany({ data: [...new Set(mediaIds)].map((mediaAssetId) => ({ kanbanId, mediaAssetId })) });
    }
    const current = await tx.kanban.findUniqueOrThrow({ where: { id: kanbanId }, select: { pictureAssetId: true, media: { select: { mediaAssetId: true } } } });
    const after = [current.pictureAssetId, ...current.media.map((m) => m.mediaAssetId)].filter((x): x is string => !!x);
    await markAttached(tx, after);
    const afterSet = new Set(after);
    await reevaluateMedia(tx, before.filter((id) => !afterSet.has(id)));
  }

  // ───────────── revisions: reads ─────────────

  private async revisionFor(actor: AuthUser, id: string): Promise<KanbanRevision> {
    const r = await this.prisma.kanbanRevision.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!r) throw new NotFoundException('Revision not found');
    return r;
  }

  private async groupNames(ids: string[]) {
    const groups = await this.prisma.userGroup.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    return new Map(groups.map((g) => [g.id, g.name]));
  }

  /** A revision as the editor and reviewers see it: proposed fields, state, timestamps and comments. */
  private async revisionView(r: KanbanRevision) {
    const p = r.payload as unknown as KanbanPayload;
    const [pic, media, names, groups] = await Promise.all([
      p.pictureAssetId ? this.prisma.mediaAsset.findUnique({ where: { id: p.pictureAssetId } }) : null,
      p.mediaAssetIds.length ? this.prisma.mediaAsset.findMany({ where: { id: { in: p.mediaAssetIds } } }) : [],
      this.creatorNames([r.createdById, r.submittedById ?? r.createdById]),
      this.groupNames(r.routingGroupIds),
    ]);
    return {
      id: r.id,
      kanbanId: r.kanbanId,
      state: r.state,
      ...p,
      picture: pic && pic.lifecycleState !== 'purged' ? await this.media.view(pic) : null,
      media: await Promise.all(media.map((m) => this.media.view(m))),
      createdBy: names.get(r.createdById) ? { id: r.createdById, name: names.get(r.createdById) } : null,
      submittedById: r.submittedById,
      submittedAt: r.submittedAt,
      preApprovedAt: r.preApprovedAt,
      approvedAt: r.approvedAt,
      publishedAt: r.publishedAt,
      routingGroups: r.routingGroupIds.map((id) => ({ id, name: groups.get(id) ?? null })),
      lastComment: r.lastComment,
      updatedAt: r.updatedAt,
    };
  }

  /** Who may see a revision directly: its creator, or anyone who holds a review-type permission in its scope. */
  private canSee(actor: AuthUser, r: KanbanRevision): boolean {
    if (r.createdById === actor.id) return true;
    const reviewer = [Permission.KanbanReview, Permission.KanbanPreApprove, Permission.KanbanApprove, Permission.KanbanPublish].some((p) => actor.permissions.has(p));
    if (!reviewer) return false;
    return isFullAccessRole(actor.role) || r.routingGroupIds.length === 0 || r.routingGroupIds.some((g) => actor.groupIds.includes(g));
  }

  async getRevision(actor: AuthUser, id: string) {
    const r = await this.revisionFor(actor, id);
    if (!this.canSee(actor, r)) throw new NotFoundException('Revision not found');
    return { ...(await this.revisionView(r)), actions: await this.revisionActions(actor, r) };
  }

  /**
   * Which workflow actions the caller may take on this revision right now. Built from the same checks the action
   * endpoints run: the controller permission, the state transition table, and the eligibility rules. Publish can still
   * fail for a reason this does not model (for example a removed SOP ordering target), which the action then reports.
   */
  private async revisionActions(actor: AuthUser, r: KanbanRevision): Promise<RevisionActionFlags> {
    const settings = await this.prisma.organizationSettings.findUnique({ where: { organizationId: actor.organizationId }, select: { allowSelfApproval: true } });
    return this.actionFlags(actor, r, settings?.allowSelfApproval ?? false);
  }

  /**
   * The only place the revision action flags are built. Used by GET /kanbans/revisions/:rid and by every inbox item,
   * so the flags on a card, a list row and a detail page can never disagree. Each flag is true only when the matching
   * endpoint would accept the request now: controller permission, state transition, and eligibility.
   *
   * Publish also requires its ordering target to still resolve, which is the same check publish() runs first.
   */
  private async actionFlags(actor: AuthUser, r: KanbanRevision, allowSelf: boolean): Promise<RevisionActionFlags> {
    const allowed = (action: RevisionActionName, controllerPermission: Permission) =>
      actor.permissions.has(controllerPermission) &&
      canTransition(action, r.state) &&
      (action === 'submit' ||
        eligibility(actor, {
          routingGroupIds: r.routingGroupIds,
          submittedById: r.submittedById,
          permission: requiredPermission(action, r.state),
          allowSelfApproval: allowSelf,
          isPublish: action === 'publish',
        }) === null);
    const flags: RevisionActionFlags = {
      submit: allowed('submit', Permission.KanbanSubmit),
      preApprove: allowed('preApprove', Permission.KanbanPreApprove),
      approve: allowed('approve', Permission.KanbanApprove),
      reject: allowed('reject', Permission.KanbanReview),
      publish: allowed('publish', Permission.KanbanPublish),
    };
    if (flags.publish) flags.publish = await this.orderingResolves(actor, r.payload as unknown as KanbanPayload);
    return flags;
  }

  /** True when publish's ordering check passes now. The same call publish() makes; a missing SOP target is the only failure. */
  private async orderingResolves(actor: AuthUser, p: KanbanPayload): Promise<boolean> {
    try {
      await this.ordering(actor, p);
      return true;
    } catch (e) {
      if (e instanceof BadRequestException) return false;
      throw e;
    }
  }

  /**
   * Approval inbox. Scoped server-side to the caller's permissions and routing, never filtered in the browser.
   * Blocked = a pending stage with no eligible approver in its scope; those items stay pending and are shown to
   * Admins and to the submitter, with the missing role named.
   */
  async inbox(actor: AuthUser) {
    const [settings, open] = await Promise.all([
      this.prisma.organizationSettings.findUnique({ where: { organizationId: actor.organizationId }, select: { allowSelfApproval: true } }),
      this.prisma.kanbanRevision.findMany({
        where: { organizationId: actor.organizationId, state: { in: OPEN_REVISION_STATES } },
        orderBy: { updatedAt: 'desc' },
        take: 200,
      }),
    ]);
    const allowSelf = settings?.allowSelfApproval ?? false;
    const rejected = await this.prisma.kanbanRevision.findMany({
      where: { organizationId: actor.organizationId, state: 'DRAFT', lastComment: { not: null }, createdById: actor.id },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    const names = await this.creatorNames(open.map((r) => r.createdById));
    const out = { preApproval: [] as object[], finalApproval: [] as object[], readyToPublish: [] as object[], blocked: [] as object[], rejected: [] as object[], mine: [] as object[] };

    for (const r of open) {
      const flags = await this.actionFlags(actor, r, allowSelf);
      const summary = { ...this.summary(r, names), actions: flags };
      if (r.createdById === actor.id) out.mine.push(summary);
      const stage = blockedStage(r.state);
      if (stage) {
        const perm = stage === 'pre' ? Permission.KanbanPreApprove : Permission.KanbanApprove;
        const pool = await this.pool.members(actor.organizationId, perm, r.routingGroupIds, r.createdById);
        if (pool.length === 0 && (isFullAccessRole(actor.role) || r.createdById === actor.id)) {
          out.blocked.push({ ...summary, blockedReason: this.blockedReason(stage) });
        }
      }
      // The lists are filtered by the same flags each item carries, so a list and its item's actions cannot disagree.
      if (r.state === 'PENDING_PRE_APPROVAL' && flags.preApprove) out.preApproval.push(summary);
      if ((r.state === 'PRE_APPROVED' || r.state === 'PENDING_PRE_APPROVAL') && flags.approve) out.finalApproval.push(summary);
      if (r.state === 'APPROVED' && flags.publish) out.readyToPublish.push(summary);
    }
    for (const r of rejected) out.rejected.push({ ...this.summary(r, names), actions: await this.actionFlags(actor, r, allowSelf) });
    return out;
  }

  private blockedReason(stage: 'pre' | 'final') {
    return stage === 'pre'
      ? 'Waiting for pre-approval, but no eligible Pre Approver exists for this group. Admins have been notified.'
      : 'Waiting for final approval, but no eligible Approver exists for this group. Admins have been notified.';
  }

  private summary(r: KanbanRevision, names: Map<string, string>) {
    const p = r.payload as unknown as KanbanPayload;
    return {
      id: r.id,
      kanbanId: r.kanbanId,
      state: r.state,
      stage: blockedStage(r.state),
      partCode: p.partCode,
      partDescription: p.partDescription,
      submitter: r.submittedById ? { id: r.submittedById, name: names.get(r.createdById) ?? null } : null,
      submittedAt: r.submittedAt,
      routingGroupIds: r.routingGroupIds,
      comment: r.lastComment,
    };
  }

  // ───────────── revisions: writes ─────────────

  private revisionAudit(actor: AuthUser, r: KanbanRevision, action: AuditActionName, meta: RequestMeta, extra: Record<string, unknown> = {}) {
    return {
      action,
      organizationId: actor.organizationId,
      actorId: actor.id,
      entityType: 'kanban_revision',
      entityId: r.id,
      metadata: { kanbanId: r.kanbanId, state: r.state, routingGroupIds: r.routingGroupIds, ...extra } as Prisma.InputJsonValue,
      ...meta,
    };
  }

  /** Denied approval actions are audited, then refused. */
  private async deny(actor: AuthUser, r: KanbanRevision, denial: Exclude<ReturnType<typeof eligibility>, null>, action: RevisionAction, meta: RequestMeta): Promise<never> {
    await this.audit.record(this.revisionAudit(actor, r, AuditAction.KanbanRevisionDenied, meta, { attempted: action, reason: denial }));
    throw new ForbiddenException(DENIAL_MESSAGES[denial]);
  }

  /** Permission and routing check for one action, against the actor's current state. */
  private async authorise(actor: AuthUser, r: KanbanRevision, action: RevisionAction, meta: RequestMeta) {
    const settings = await this.prisma.organizationSettings.findUnique({ where: { organizationId: actor.organizationId }, select: { allowSelfApproval: true } });
    const denial = eligibility(actor, {
      routingGroupIds: r.routingGroupIds,
      submittedById: r.submittedById,
      permission: requiredPermission(action, r.state),
      allowSelfApproval: settings?.allowSelfApproval ?? false,
      isPublish: action === 'publish',
    });
    if (denial) await this.deny(actor, r, denial, action, meta);
  }

  /** Create a new card as a draft. The live card does not exist until the draft is published. */
  async create(actor: AuthUser, dto: CreateKanbanDto, meta: RequestMeta) {
    const payload = await this.merge(actor, emptyPayload(), dto);
    // Ordering is mandatory on create, even when the DTO leaves it untouched (the empty default is not a real target).
    Object.assign(payload, await this.ordering(actor, dto));
    await this.media.assertUsable(actor.organizationId, this.assetIds(payload));
    const r = await this.prisma.$transaction(async (tx) => {
      const created = await tx.kanbanRevision.create({
        data: {
          organizationId: actor.organizationId,
          kanbanId: null,
          state: 'DRAFT',
          payload: payload as unknown as Prisma.InputJsonValue,
          routingGroupIds: this.routingFor(actor),
          createdById: actor.id,
          updatedById: actor.id,
        },
      });
      await markAttached(tx, this.assetIds(payload));
      await this.audit.record(this.revisionAudit(actor, created, AuditAction.KanbanRevisionCreated, meta, { previousState: null, newState: 'DRAFT' }), tx);
      return created;
    });
    return this.revisionView(r);
  }

  /**
   * Edit a live card. Never writes the live row: it creates or updates the card's single open DRAFT.
   * A card whose revision is in review cannot be edited until that review is resolved.
   */
  async update(actor: AuthUser, id: string, dto: UpdateKanbanDto, meta: RequestMeta) {
    const live = await this.find(actor, id);
    const open = await this.prisma.kanbanRevision.findFirst({ where: { organizationId: actor.organizationId, kanbanId: id, state: { in: OPEN_REVISION_STATES } } });
    if (open && LOCKED_FOR_EDIT.includes(open.state)) {
      throw new ConflictException('This card has a revision awaiting review. Wait for the decision, or ask a reviewer to reject it.');
    }
    if (open) {
      const before = this.assetIds(open.payload as unknown as KanbanPayload);
      const payload = await this.merge(actor, open.payload as unknown as KanbanPayload, dto);
      await this.media.assertUsable(actor.organizationId, this.assetIds(payload));
      const r = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.kanbanRevision.updateMany({
          where: { id: open.id, state: 'DRAFT' },
          data: { payload: payload as unknown as Prisma.InputJsonValue, updatedById: actor.id, lastComment: null, lastCommentById: null },
        });
        if (updated.count !== 1) throw new ConflictException('The draft changed while you were editing. Reload and try again.');
        const afterSet = new Set(this.assetIds(payload));
        await markAttached(tx, this.assetIds(payload));
        await reevaluateMedia(tx, before.filter((x) => !afterSet.has(x)));
        const fresh = await tx.kanbanRevision.findUniqueOrThrow({ where: { id: open.id } });
        await this.audit.record(this.revisionAudit(actor, fresh, AuditAction.KanbanRevisionUpdated, meta, { previousState: 'DRAFT', newState: 'DRAFT' }), tx);
        return fresh;
      });
      return this.revisionView(r);
    }
    const payload = await this.merge(actor, this.payloadFromLive(live), dto);
    await this.media.assertUsable(actor.organizationId, this.assetIds(payload));
    try {
      const r = await this.prisma.$transaction(async (tx) => {
        const created = await tx.kanbanRevision.create({
          data: {
            organizationId: actor.organizationId,
            kanbanId: id,
            state: 'DRAFT',
            payload: payload as unknown as Prisma.InputJsonValue,
            routingGroupIds: this.routingFor(actor),
            createdById: actor.id,
            updatedById: actor.id,
          },
        });
        await markAttached(tx, this.assetIds(payload));
        await this.audit.record(this.revisionAudit(actor, created, AuditAction.KanbanRevisionCreated, meta, { previousState: null, newState: 'DRAFT' }), tx);
        return created;
      });
      return this.revisionView(r);
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('This card already has an open revision. Reload to see it.');
      throw e;
    }
  }

  /** Admin submissions have no group restriction (empty = organisation-wide); everyone else snapshots their groups. */
  private routingFor(actor: AuthUser): string[] {
    return isFullAccessRole(actor.role) ? [] : [...actor.groupIds];
  }

  /** Atomically moves a revision between states; a stale or concurrent request fails with 409 instead of double-acting. */
  private async transition(
    tx: Tx,
    actor: AuthUser,
    r: KanbanRevision,
    action: RevisionAction,
    data: Prisma.KanbanRevisionUncheckedUpdateManyInput,
  ): Promise<KanbanRevision> {
    assertTransition(action, r.state);
    const moved = await tx.kanbanRevision.updateMany({
      where: { id: r.id, state: r.state },
      data: { ...data, state: targetState(action) },
    });
    if (moved.count !== 1) throw new ConflictException('This revision was changed by someone else. Reload and try again.');
    return tx.kanbanRevision.findUniqueOrThrow({ where: { id: r.id } });
  }

  async submit(actor: AuthUser, id: string, meta: RequestMeta) {
    const r = await this.revisionFor(actor, id);
    if (r.state !== 'DRAFT') throw new ConflictException(`Only a draft can be submitted (this one is ${r.state})`);
    const submitted = await this.prisma.$transaction(async (tx) => {
      const next = await this.transition(tx, actor, r, 'submit', {
        submittedById: actor.id,
        submittedAt: new Date(),
        routingGroupIds: this.routingFor(actor),
        lastComment: null,
        lastCommentById: null,
      });
      await this.audit.record(this.revisionAudit(actor, next, AuditAction.KanbanRevisionSubmitted, meta, { previousState: 'DRAFT', newState: next.state }), tx);
      return next;
    });
    await this.notifyStage(actor, submitted, 'pre', meta);
    return this.revisionView(submitted);
  }

  async preApprove(actor: AuthUser, id: string, meta: RequestMeta) {
    const r = await this.revisionFor(actor, id);
    await this.authorise(actor, r, 'preApprove', meta);
    const next = await this.prisma.$transaction(async (tx) => {
      const n = await this.transition(tx, actor, r, 'preApprove', { preApprovedById: actor.id, preApprovedAt: new Date() });
      await this.audit.record(this.revisionAudit(actor, n, AuditAction.KanbanRevisionPreApproved, meta, { previousState: r.state, newState: n.state }), tx);
      return n;
    });
    await this.notifyStage(actor, next, 'final', meta);
    return this.revisionView(next);
  }

  async approve(actor: AuthUser, id: string, meta: RequestMeta) {
    const r = await this.revisionFor(actor, id);
    await this.authorise(actor, r, 'approve', meta);
    const next = await this.prisma.$transaction(async (tx) => {
      const n = await this.transition(tx, actor, r, 'approve', { approvedById: actor.id, approvedAt: new Date() });
      await this.audit.record(this.revisionAudit(actor, n, AuditAction.KanbanRevisionApproved, meta, { previousState: r.state, newState: n.state }), tx);
      return n;
    });
    return this.revisionView(next);
  }

  /** Rejection returns the revision to DRAFT with the reviewer's comment; the editor may edit and resubmit it. */
  async reject(actor: AuthUser, id: string, comment: string, meta: RequestMeta) {
    const r = await this.revisionFor(actor, id);
    const perm = requiredPermission('reject', r.state);
    const settings = await this.prisma.organizationSettings.findUnique({ where: { organizationId: actor.organizationId }, select: { allowSelfApproval: true } });
    const denial = eligibility(actor, { routingGroupIds: r.routingGroupIds, submittedById: r.submittedById, permission: perm, allowSelfApproval: settings?.allowSelfApproval ?? false, isPublish: false });
    if (denial) await this.deny(actor, r, denial, 'reject', meta);
    const text = comment.trim();
    const next = await this.prisma.$transaction(async (tx) => {
      const n = await this.transition(tx, actor, r, 'reject', {
        lastComment: text,
        lastCommentById: actor.id,
        preApprovedAt: null,
        preApprovedById: null,
        approvedAt: null,
        approvedById: null,
      });
      await this.audit.record(this.revisionAudit(actor, n, AuditAction.KanbanRevisionRejected, meta, { previousState: r.state, newState: n.state, comment: text }), tx);
      return n;
    });
    if (next.submittedById) {
      await this.notifyUsers(actor, next, [next.submittedById], 'Your kanban change was rejected', `Your change to ${(next.payload as unknown as KanbanPayload).partCode} was rejected by ${actor.name}.\n\nReason: ${text}\n\nEdit the draft and resubmit when ready.`, meta);
    }
    return this.revisionView(next);
  }

  /**
   * Publish is the only operation that changes the live card. Requires publish permission and scope; applies the
   * proposed fields, media and ordering in one transaction and re-validates ordering targets first.
   */
  async publish(actor: AuthUser, id: string, meta: RequestMeta) {
    const r = await this.revisionFor(actor, id);
    await this.authorise(actor, r, 'publish', meta);
    const p = r.payload as unknown as KanbanPayload;
    await this.ordering(actor, p); // a SOP ordering target may have been removed since the draft was saved
    const published = await this.prisma.$transaction(async (tx) => {
      const n = await this.transition(tx, actor, r, 'publish', { publishedById: actor.id, publishedAt: new Date() });
      const data = {
        partCode: p.partCode,
        partDescription: p.partDescription,
        supplier: p.supplier,
        supplierPartNo: p.supplierPartNo,
        usedFor: p.usedFor,
        orderWhen: p.orderWhen,
        orderQty: p.orderQty,
        deliveryTime: p.deliveryTime,
        location: p.location,
        price: p.price,
        carriage: p.carriage,
        customField1: p.customField1,
        customField2: p.customField2,
        tag: p.tag,
        color: p.color,
        barcode: p.barcode,
        template: p.template,
        orderingType: p.orderingType,
        orderingUrl: p.orderingUrl,
        orderingSopId: p.orderingSopId,
        orderingEmail: p.orderingEmail,
        pictureAssetId: p.pictureAssetId,
      };
      let kanbanId = r.kanbanId;
      if (kanbanId) {
        const before = await tx.kanban.findUniqueOrThrow({ where: { id: kanbanId }, select: { pictureAssetId: true, media: { select: { mediaAssetId: true } } } });
        await tx.kanban.update({ where: { id: kanbanId }, data });
        await this.syncMedia(tx, kanbanId, [before.pictureAssetId, ...before.media.map((m) => m.mediaAssetId)].filter((x): x is string => !!x), p.mediaAssetIds);
      } else {
        const created = await tx.kanban.create({ data: { ...data, organizationId: actor.organizationId, createdById: r.createdById } });
        kanbanId = created.id;
        await tx.kanbanRevision.update({ where: { id: r.id }, data: { kanbanId } });
        await this.syncMedia(tx, kanbanId, [], p.mediaAssetIds);
      }
      await this.audit.record(this.revisionAudit(actor, { ...n, kanbanId }, AuditAction.KanbanRevisionPublished, meta, { previousState: r.state, newState: 'PUBLISHED', directPublish: r.state !== 'APPROVED' }), tx);
      return { ...n, kanbanId };
    });
    if (published.submittedById && published.submittedById !== actor.id) {
      await this.notifyUsers(actor, published, [published.submittedById], 'Your kanban change was published', `${actor.name} published your change to ${p.partCode}.`, meta);
    }
    return this.get(actor, published.kanbanId!);
  }

  /** Editors may discard their own draft, or any draft if they can publish. The live card is never affected. */
  async discard(actor: AuthUser, id: string, meta: RequestMeta) {
    const r = await this.revisionFor(actor, id);
    if (r.createdById !== actor.id && !actor.permissions.has(Permission.KanbanPublish)) throw new ForbiddenException('You can only discard your own drafts');
    const assets = this.assetIds(r.payload as unknown as KanbanPayload);
    await this.prisma.$transaction(async (tx) => {
      await this.transition(tx, actor, r, 'discard', {});
      await reevaluateMedia(tx, assets);
      await this.audit.record(this.revisionAudit(actor, r, AuditAction.KanbanRevisionDiscarded, meta, { previousState: r.state, newState: 'DISCARDED' }), tx);
    });
  }

  // ───────────── notifications (routed to the stage's pool; Admins when blocked) ─────────────

  private async notifyStage(actor: AuthUser, r: KanbanRevision, stage: 'pre' | 'final', meta: RequestMeta) {
    const p = r.payload as unknown as KanbanPayload;
    const perm = stage === 'pre' ? Permission.KanbanPreApprove : Permission.KanbanApprove;
    const pool = await this.pool.members(actor.organizationId, perm, r.routingGroupIds, r.createdById);
    const groupMap = await this.groupNames(r.routingGroupIds);
    const group = r.routingGroupIds.length ? [...groupMap.values()].join(', ') : 'organisation-wide';
    if (pool.length === 0) {
      await this.audit.record(this.revisionAudit(actor, r, AuditAction.KanbanRevisionBlocked, meta, { stage, reason: 'no_eligible_approver' }));
      const admins = await this.pool.admins(actor.organizationId);
      await this.pool.notify(actor.organizationId, admins, { entityType: 'kanban_revision', entityId: r.id }, {
        subject: `Approval blocked: no ${stage === 'pre' ? 'Pre Approver' : 'Approver'} for ${p.partCode}`,
        text: `A kanban change for ${p.partCode} is waiting for ${stage === 'pre' ? 'pre-approval' : 'final approval'}, but no eligible ${stage === 'pre' ? 'Pre Approver' : 'Approver'} currently exists for its group (${group}).\n\nIt stays pending until one is available. Assign a user with the right role and group, or act on it yourself.`,
      });
      return;
    }
    const subject = stage === 'pre' ? `Kanban update requires your review: ${p.partCode}` : `Kanban change passed pre-approval: ${p.partCode}`;
    const text =
      stage === 'pre'
        ? `${actor.name} submitted a kanban change for ${p.partCode} (group: ${group}). It requires your pre-approval.`
        : `${actor.name} pre-approved a kanban change for ${p.partCode} (group: ${group}). It requires final approval.`;
    await this.pool.notify(actor.organizationId, pool, { entityType: 'kanban_revision', entityId: r.id }, { subject, text });
  }

  private async notifyUsers(actor: AuthUser, r: KanbanRevision, userIds: string[], subject: string, text: string, _meta: RequestMeta) {
    const users = await this.prisma.user.findMany({ where: { id: { in: userIds }, organizationId: actor.organizationId }, select: { id: true, name: true, email: true, orgRole: true } });
    const recipients: PoolMember[] = users.map((u) => ({ ...u, groupIds: [] }));
    await this.pool.notify(actor.organizationId, recipients, { entityType: 'kanban_revision', entityId: r.id }, { subject, text });
  }

  // ───────────── live deletion (publication-level) ─────────────

  /** Deleting a published card changes the live catalogue, so it requires publish authority as well as delete. */
  async remove(actor: AuthUser, id: string, meta: RequestMeta) {
    if (!actor.permissions.has(Permission.KanbanPublish)) throw new ForbiddenException('Deleting a published kanban requires publish permission');
    const k = await this.find(actor, id);
    const open = await this.prisma.kanbanRevision.findFirst({ where: { organizationId: actor.organizationId, kanbanId: id, state: { in: OPEN_REVISION_STATES } } });
    if (open) throw new ConflictException('This card has an open revision. Discard or resolve it before deleting the card.');
    await this.prisma.$transaction(async (tx) => {
      await tx.kanban.update({ where: { id }, data: { deletedAt: new Date() } });
      await reevaluateMedia(tx, [k.pictureAssetId, ...k.media.map((m) => m.mediaAssetId)].filter((x): x is string => !!x));
      await this.audit.record({ action: AuditAction.KanbanDeleted, organizationId: actor.organizationId, actorId: actor.id, entityType: 'kanban', entityId: id, metadata: { partCode: k.partCode, directPublish: true }, ...meta }, tx);
    });
  }

  // ───────────── bulk ─────────────

  /**
   * CSV import creates one draft revision per valid row. It never writes live cards. Invalid rows are reported and
   * skipped; valid rows are still created (partial success). `dryRun` validates only.
   */
  async bulkImport(actor: AuthUser, csv: string, dryRun: boolean, meta: RequestMeta) {
    const rows = parseCsvWithHeader(csv);
    if (!rows.length) throw new BadRequestException('CSV has no data rows');
    if (rows.length > 2000) throw new BadRequestException('At most 2000 rows per import');
    if (!rows[0] || !('part_code' in rows[0].values)) throw new BadRequestException('CSV must include a "part_code" column');

    const sopRefs = [...new Set(rows.map((r) => r.values.ordering_sop_ref).filter(Boolean))];
    const sops = sopRefs.length
      ? await this.prisma.sop.findMany({ where: { organizationId: actor.organizationId, referenceNo: { in: sopRefs }, deletedAt: null }, select: { id: true, referenceNo: true } })
      : [];
    const sopByRef = new Map(sops.map((s) => [s.referenceNo, s.id]));

    const errors: { row: number; error: string }[] = [];
    const drafts: KanbanPayload[] = [];
    for (const { row, values: v } of rows) {
      try {
        if (!v.part_code) throw new Error('part_code is required');
        const type = (v.ordering_type || (v.ordering_url ? 'url' : v.ordering_email ? 'email' : v.ordering_sop_ref ? 'sop' : 'url')).toLowerCase();
        if (!['url', 'sop', 'email'].includes(type)) throw new Error('ordering_type must be url, sop or email');
        let orderingSopId: string | undefined;
        if (type === 'sop') {
          orderingSopId = sopByRef.get(v.ordering_sop_ref);
          if (!orderingSopId) throw new Error(`Unknown SOP reference "${v.ordering_sop_ref}"`);
        }
        const ordering = await this.ordering(actor, {
          orderingType: type as KanbanOrderingType,
          orderingUrl: v.ordering_url,
          orderingEmail: v.ordering_email,
          orderingSopId,
        });
        const money = (s: string, name: string) => {
          if (!s) return null;
          const n = Number(s.replace(/[^\d.\-]/g, ''));
          if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
          return Math.round(n * 100) / 100;
        };
        const template = v.template || '01';
        if (!['01', '02'].includes(template)) throw new Error('template must be 01 or 02');
        const s = (x: string, max = 500) => {
          if (x.length > max) throw new Error(`value too long (max ${max})`);
          return x || null;
        };
        drafts.push({
          ...emptyPayload(),
          partCode: s(v.part_code, 100)!,
          partDescription: s(v.part_description ?? '', 2000),
          supplier: s(v.supplier ?? '', 200),
          supplierPartNo: s(v.supplier_part_no ?? '', 200),
          usedFor: s(v.used_for ?? ''),
          orderWhen: s(v.order_when ?? '', 200),
          orderQty: s(v.order_qty ?? '', 200),
          deliveryTime: s(v.delivery_time ?? '', 200),
          location: s(v.location ?? '', 200),
          price: money(v.price ?? '', 'price'),
          carriage: money(v.carriage ?? '', 'carriage'),
          customField1: s(v.custom_field_1 ?? ''),
          customField2: s(v.custom_field_2 ?? ''),
          tag: s(v.tag ?? '', 100),
          color: s(v.color ?? '', 30),
          barcode: s(v.barcode ?? '', 200),
          template,
          ...ordering,
        });
      } catch (e) {
        errors.push({ row, error: (e as Error).message });
      }
    }
    if (dryRun || drafts.length === 0) return { imported: 0, valid: drafts.length, errors, drafts: dryRun ? drafts.length : 0 };

    const routing = this.routingFor(actor);
    await this.prisma.$transaction(async (tx) => {
      await tx.kanbanRevision.createMany({
        data: drafts.map((payload) => ({
          organizationId: actor.organizationId,
          kanbanId: null,
          state: 'DRAFT' as const,
          payload: payload as unknown as Prisma.InputJsonValue,
          routingGroupIds: routing,
          createdById: actor.id,
          updatedById: actor.id,
        })),
      });
      await this.audit.record(
        { action: AuditAction.KanbanBulkImport, organizationId: actor.organizationId, actorId: actor.id, entityType: 'kanban_revision', metadata: { drafts: drafts.length, failedRows: errors.length, previousState: null, newState: 'DRAFT' }, ...meta },
        tx,
      );
    });
    return { imported: drafts.length, valid: drafts.length, errors };
  }

  /**
   * Direct publisher-level bulk edit of live cards. Deliberately bypasses the revision workflow, so it requires
   * publish authority and is audited as a direct publish.
   */
  async bulkEdit(actor: AuthUser, dto: BulkEditDto, meta: RequestMeta) {
    if (!actor.permissions.has(Permission.KanbanPublish)) throw new ForbiddenException('Bulk edit publishes directly and requires publish permission');
    const ids = [...new Set(dto.ids)];
    const patch = Object.fromEntries(Object.entries(dto.patch).filter(([, v]) => v !== undefined).map(([k, v]) => [k, typeof v === 'string' ? v.trim() || null : v]));
    if (!Object.keys(patch).length) throw new BadRequestException('Nothing to update');
    if ('template' in patch && !patch.template) throw new BadRequestException('template cannot be empty');
    return this.prisma.$transaction(async (tx) => {
      const owned = await tx.kanban.count({ where: { id: { in: ids }, organizationId: actor.organizationId, deletedAt: null } });
      if (owned !== ids.length) throw new NotFoundException('One or more kanbans not found');
      const r = await tx.kanban.updateMany({ where: { id: { in: ids }, organizationId: actor.organizationId, deletedAt: null }, data: patch });
      await this.audit.record(
        { action: AuditAction.KanbanBulkEdit, organizationId: actor.organizationId, actorId: actor.id, entityType: 'kanban', metadata: { count: r.count, fields: Object.keys(patch), directPublish: true }, ...meta },
        tx,
      );
      return { updated: r.count };
    });
  }

  async exportCsv(actor: AuthUser): Promise<string> {
    const rows = await this.prisma.kanban.findMany({
      where: { organizationId: actor.organizationId, deletedAt: null },
      include: { orderingSop: { select: { referenceNo: true } } },
      orderBy: { partCode: 'asc' },
    });
    const line = (k: (typeof rows)[number]) =>
      [
        k.partCode, k.partDescription, k.supplier, k.supplierPartNo, k.usedFor, k.orderWhen, k.orderQty, k.deliveryTime,
        k.location, k.price?.toString(), k.carriage?.toString(), k.customField1, k.customField2, k.orderingType,
        k.orderingUrl, k.orderingSop?.referenceNo, k.orderingEmail, k.tag, k.color, k.barcode, k.template,
      ].map(csvCell).join(',');
    return [KANBAN_CSV_COLUMNS.join(','), ...rows.map(line)].join('\r\n') + '\r\n';
  }

  /** Printable kanban cards: two A4 pages per card (option 1 small strip + bin label, option 2 large) — see kanban-print.ts. */
  async printPdf(actor: AuthUser, ids: string[]): Promise<Buffer> {
    const unique = [...new Set(ids)];
    const rows = await this.prisma.kanban.findMany({
      where: { id: { in: unique }, organizationId: actor.organizationId, deletedAt: null },
      include: { picture: true, orderingSop: { select: { referenceNo: true, name: true, qrPublicToken: true } } },
      orderBy: { partCode: 'asc' },
    });
    if (rows.length !== unique.length) throw new NotFoundException('One or more kanbans not found');
    const cards: PrintableKanban[] = [];
    for (const k of rows) cards.push(await this.printable(k));
    const video = env.kanbanVideoUrl;
    const videoQr = video ? await QRCode.toDataURL(video, { margin: 0, width: 300 }) : null;
    return this.renderer.htmlToPdf(kanbanPrintHtml(cards, videoQr));
  }

  private async printable(
    k: Kanban & { picture: { storageKey: string; mimeType: string; type: string } | null; orderingSop: { referenceNo: string; name: string; qrPublicToken: string } | null },
  ): Promise<PrintableKanban> {
    const pictureUri =
      k.picture && k.picture.type === 'image' ? `data:${k.picture.mimeType};base64,${(await this.storage.get(k.picture.storageKey)).toString('base64')}` : null;
    const qrTarget =
      k.orderingType === 'url' && k.orderingUrl
        ? k.orderingUrl
        : k.orderingType === 'email' && k.orderingEmail
          ? `mailto:${k.orderingEmail}?subject=${encodeURIComponent(`Order ${k.partCode}`)}`
          : k.orderingType === 'sop' && k.orderingSop
            ? `${env.publicAppUrl}/s/${k.orderingSop.qrPublicToken}`
            : null;
    const color = /^#?[0-9a-f]{3,8}$|^[a-z]{3,20}$/i.test(k.color ?? '') ? (k.color!.match(/^[0-9a-f]+$/i) ? `#${k.color}` : k.color!) : BRAND.button;
    return {
      partCode: k.partCode,
      partDescription: k.partDescription,
      supplier: k.supplier,
      supplierPartNo: k.supplierPartNo,
      usedFor: k.usedFor,
      orderWhen: k.orderWhen,
      orderQty: k.orderQty,
      deliveryTime: k.deliveryTime,
      location: k.location,
      price: k.price?.toString() ?? null,
      carriage: k.carriage?.toString() ?? null,
      template: k.template,
      color,
      barcode: k.barcode || k.partCode,
      pictureUri,
      qrUri: qrTarget ? await QRCode.toDataURL(qrTarget, { margin: 0, width: 300 }) : null,
    };
  }
}

/** Starting point for a brand-new card. Ordering is always supplied by the create DTO. */
function emptyPayload(): KanbanPayload {
  return {
    partCode: '',
    partDescription: null,
    supplier: null,
    supplierPartNo: null,
    usedFor: null,
    orderWhen: null,
    orderQty: null,
    deliveryTime: null,
    location: null,
    price: null,
    carriage: null,
    customField1: null,
    customField2: null,
    tag: null,
    color: null,
    barcode: null,
    template: '01',
    orderingType: 'url',
    orderingUrl: null,
    orderingSopId: null,
    orderingEmail: null,
    pictureAssetId: null,
    mediaAssetIds: [],
  };
}

const HISTORY_LABELS: Record<string, string> = {
  'kanban.revision.created': 'Draft created',
  'kanban.revision.updated': 'Draft edited',
  'kanban.revision.submitted': 'Submitted for review',
  'kanban.revision.pre_approved': 'Pre-approved',
  'kanban.revision.approved': 'Approved',
  'kanban.revision.rejected': 'Rejected',
  'kanban.revision.published': 'Published',
  'kanban.revision.discarded': 'Draft discarded',
  'kanban.revision.blocked': 'Blocked: no eligible approver',
  'kanban.revision.authorization_denied': 'Approval action refused',
  'kanban.deleted': 'Deleted (publish)',
  'kanban.bulk.import': 'Bulk imported as drafts',
  'kanban.bulk.edit': 'Bulk edited (direct publish)',
};
