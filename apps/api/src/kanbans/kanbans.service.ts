import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import QRCode from 'qrcode';
import { env } from '../config/env';
import { BRAND } from '../pdf/brand';
import { Kanban, KanbanOrderingType, Prisma } from '@prisma/client';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { csvCell, parseCsvWithHeader } from '../common/csv';
import { RequestMeta } from '../common/decorators';
import { MediaService } from '../media/media.service';
import { markAttached, reevaluateMedia } from '../media/media-lifecycle';
import { PdfRendererService } from '../pdf/pdf-renderer.service';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { kanbanPrintHtml, PrintableKanban } from './kanban-print';
import { BulkEditDto, CreateKanbanDto, ListKanbansQuery, UpdateKanbanDto } from './kanban.dto';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

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

@Injectable()
export class KanbansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly renderer: PdfRendererService,
  ) {}

  // ───────────── queries ─────────────

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
    const names = await this.creatorNames(rows.map((r) => r.createdById));
    return { total, facets, items: await Promise.all(rows.map((r) => this.view(r, names))) };
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
    return this.view(k, await this.creatorNames([k.createdById]));
  }

  /** Change history of one card, newest first, from the activity events recorded for it (create / edit). */
  async history(actor: AuthUser, id: string) {
    const k = await this.find(actor, id);
    const events = await this.prisma.activityEvent.findMany({
      where: { organizationId: actor.organizationId, entityType: 'kanban', entityId: id, eventType: { in: ['kanban.created', 'kanban.updated'] } },
      orderBy: { occurredAt: 'desc' },
      take: 200,
    });
    const rows = events.map((e) => ({ id: e.id, action: e.eventType === 'kanban.created' ? 'Created' : 'Edited', actorId: e.actorId, at: e.occurredAt }));
    // cards created by CSV import have no per-card "created" event: fall back to the card's own record
    if (!events.some((e) => e.eventType === 'kanban.created')) rows.push({ id: `created-${k.id}`, action: 'Created', actorId: k.createdById, at: k.createdAt });
    const names = await this.creatorNames(rows.map((r) => r.actorId).filter((x): x is string => !!x));
    return rows.map(({ actorId, ...r }) => ({ ...r, by: actorId ? (names.get(actorId) ?? null) : null }));
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

  private fields(dto: CreateKanbanDto | UpdateKanbanDto) {
    const t = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);
    return {
      partCode: dto.partCode?.trim(),
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

  // ───────────── commands ─────────────

  async create(actor: AuthUser, dto: CreateKanbanDto) {
    const ordering = await this.ordering(actor, dto);
    await this.media.assertUsable(actor.organizationId, [dto.pictureAssetId, ...(dto.mediaAssetIds ?? [])].filter((x): x is string => !!x));
    const id = await this.prisma.$transaction(async (tx) => {
      const k = await tx.kanban.create({
        data: {
          ...this.fields(dto),
          partCode: dto.partCode.trim(),
          ...ordering,
          pictureAssetId: dto.pictureAssetId ?? null,
          organizationId: actor.organizationId,
          createdById: actor.id,
        },
      });
      await this.syncMedia(tx, k.id, [], dto.mediaAssetIds ?? []);
      return k.id;
    });
    return this.get(actor, id);
  }

  async update(actor: AuthUser, id: string, dto: UpdateKanbanDto) {
    const existing = await this.find(actor, id);
    const orderingTouched = dto.orderingType !== undefined || dto.orderingUrl !== undefined || dto.orderingSopId !== undefined || dto.orderingEmail !== undefined;
    const ordering = orderingTouched
      ? await this.ordering(actor, {
          orderingType: dto.orderingType ?? existing.orderingType,
          orderingUrl: dto.orderingUrl !== undefined ? dto.orderingUrl : existing.orderingUrl,
          orderingSopId: dto.orderingSopId !== undefined ? dto.orderingSopId : existing.orderingSopId,
          orderingEmail: dto.orderingEmail !== undefined ? dto.orderingEmail : existing.orderingEmail,
        })
      : {};
    await this.media.assertUsable(actor.organizationId, [dto.pictureAssetId, ...(dto.mediaAssetIds ?? [])].filter((x): x is string => !!x));
    const before = [existing.pictureAssetId, ...existing.media.map((m) => m.mediaAssetId)].filter((x): x is string => !!x);
    await this.prisma.$transaction(async (tx) => {
      await tx.kanban.update({
        where: { id },
        data: { ...this.fields(dto), ...ordering, pictureAssetId: dto.pictureAssetId === undefined ? undefined : dto.pictureAssetId },
      });
      await this.syncMedia(tx, id, before, dto.mediaAssetIds);
    });
    return this.get(actor, id);
  }

  /** Soft delete (§13); media that only this card referenced becomes orphaned. */
  async remove(actor: AuthUser, id: string) {
    const k = await this.find(actor, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.kanban.update({ where: { id }, data: { deletedAt: new Date() } });
      await reevaluateMedia(tx, [k.pictureAssetId, ...k.media.map((m) => m.mediaAssetId)].filter((x): x is string => !!x));
    });
  }

  // ───────────── bulk (role-gated, no plan gating — §16 Phase 6) ─────────────

  /**
   * All-or-nothing CSV import: every row is validated first; nothing is
   * written unless all rows are valid. `dryRun` validates only.
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
    const data: Prisma.KanbanCreateManyInput[] = [];
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
        data.push({
          organizationId: actor.organizationId,
          createdById: actor.id,
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
    if (errors.length || dryRun) return { imported: 0, valid: data.length, errors };

    await this.prisma.$transaction(async (tx) => {
      await tx.kanban.createMany({ data });
      await this.audit.record(
        { action: AuditAction.KanbanBulkImport, organizationId: actor.organizationId, actorId: actor.id, entityType: 'kanban', metadata: { rows: data.length }, ...meta },
        tx,
      );
    });
    return { imported: data.length, valid: data.length, errors };
  }

  async bulkEdit(actor: AuthUser, dto: BulkEditDto, meta: RequestMeta) {
    const ids = [...new Set(dto.ids)];
    const patch = Object.fromEntries(Object.entries(dto.patch).filter(([, v]) => v !== undefined).map(([k, v]) => [k, typeof v === 'string' ? v.trim() || null : v]));
    if (!Object.keys(patch).length) throw new BadRequestException('Nothing to update');
    if ('template' in patch && !patch.template) throw new BadRequestException('template cannot be empty');
    return this.prisma.$transaction(async (tx) => {
      const owned = await tx.kanban.count({ where: { id: { in: ids }, organizationId: actor.organizationId, deletedAt: null } });
      if (owned !== ids.length) throw new NotFoundException('One or more kanbans not found');
      const r = await tx.kanban.updateMany({ where: { id: { in: ids }, organizationId: actor.organizationId, deletedAt: null }, data: patch });
      await this.audit.record(
        { action: AuditAction.KanbanBulkEdit, organizationId: actor.organizationId, actorId: actor.id, entityType: 'kanban', metadata: { count: r.count, fields: Object.keys(patch) }, ...meta },
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
