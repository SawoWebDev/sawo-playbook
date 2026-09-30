import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { canSeeUnpublished } from '../sops/sops.service';

export const MAX_FOLDER_DEPTH = 10;

/**
 * Phase 5: folder organisation/navigation under the Organization + Role model.
 * Folder-scoped permissions (`folder_scope`) are explicitly post-MVP (§6.10).
 */
@Injectable()
export class FoldersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(actor: AuthUser) {
    const folders = await this.prisma.folder.findMany({
      where: { organizationId: actor.organizationId, deletedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, parentId: true, createdAt: true },
    });
    const sopWhere: Prisma.SopWhereInput = { organizationId: actor.organizationId, deletedAt: null, folderId: { not: null }, archivedAt: null };
    if (!canSeeUnpublished(actor.role)) sopWhere.currentPublishedVersionId = { not: null };
    const counts = await this.prisma.sop.groupBy({ by: ['folderId'], where: sopWhere, _count: { _all: true } });
    const countBy = new Map(counts.map((c) => [c.folderId, c._count._all]));
    return folders.map((f) => ({ ...f, sopCount: countBy.get(f.id) ?? 0 }));
  }

  private async find(actor: AuthUser, id: string) {
    const f = await this.prisma.folder.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null } });
    if (!f) throw new NotFoundException('Folder not found');
    return f;
  }

  /** Returns [folder, parent, grandparent, …] ids, stopping at the root. */
  private async ancestry(organizationId: string, id: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH RECURSIVE up AS (
        SELECT id, parent_id, 1 AS depth FROM folder WHERE id = ${id}::uuid AND organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT f.id, f.parent_id, up.depth + 1 FROM folder f JOIN up ON f.id = up.parent_id
        WHERE up.depth < 100
      )
      SELECT id FROM up`;
    return rows.map((r) => r.id);
  }

  /** All descendant folder ids (inclusive). Used for "include subfolders" filtering. */
  async descendants(organizationId: string, id: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH RECURSIVE down AS (
        SELECT id FROM folder WHERE id = ${id}::uuid AND organization_id = ${organizationId}::uuid AND deleted_at IS NULL
        UNION
        SELECT f.id FROM folder f JOIN down ON f.parent_id = down.id WHERE f.deleted_at IS NULL
      )
      SELECT id FROM down`;
    return rows.map((r) => r.id);
  }

  private async assertUniqueName(actor: AuthUser, parentId: string | null, name: string, exceptId?: string) {
    const clash = await this.prisma.folder.findFirst({
      where: {
        organizationId: actor.organizationId,
        parentId,
        deletedAt: null,
        name: { equals: name, mode: 'insensitive' },
        id: exceptId ? { not: exceptId } : undefined,
      },
    });
    if (clash) throw new ConflictException('A folder with this name already exists here');
  }

  async create(actor: AuthUser, name: string, parentId: string | null) {
    const clean = name.trim();
    if (parentId) {
      await this.find(actor, parentId);
      if ((await this.ancestry(actor.organizationId, parentId)).length >= MAX_FOLDER_DEPTH) {
        throw new BadRequestException(`Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep`);
      }
    }
    await this.assertUniqueName(actor, parentId, clean);
    return this.prisma.folder.create({
      data: { organizationId: actor.organizationId, name: clean, parentId, createdById: actor.id },
      select: { id: true, name: true, parentId: true, createdAt: true },
    });
  }

  async update(actor: AuthUser, id: string, dto: { name?: string; parentId?: string | null }) {
    const folder = await this.find(actor, id);
    const parentId = dto.parentId === undefined ? folder.parentId : dto.parentId;
    if (dto.parentId !== undefined && dto.parentId !== null) {
      await this.find(actor, dto.parentId);
      // Moving a folder under itself or one of its descendants would create a cycle.
      if ((await this.ancestry(actor.organizationId, dto.parentId)).includes(id)) {
        throw new BadRequestException('A folder cannot be moved into itself or one of its subfolders');
      }
    }
    const name = dto.name?.trim() ?? folder.name;
    await this.assertUniqueName(actor, parentId, name, id);
    return this.prisma.folder.update({
      where: { id },
      data: { name, parentId },
      select: { id: true, name: true, parentId: true, createdAt: true },
    });
  }

  /** Soft delete (§13). Only empty folders can be deleted so no SOP silently changes location. */
  async remove(actor: AuthUser, id: string) {
    await this.find(actor, id);
    const [children, sops] = await Promise.all([
      this.prisma.folder.count({ where: { parentId: id, deletedAt: null } }),
      this.prisma.sop.count({ where: { folderId: id, deletedAt: null } }),
    ]);
    if (children || sops) throw new ConflictException('Folder is not empty — move or delete its contents first');
    await this.prisma.folder.update({ where: { id }, data: { deletedAt: new Date(), deletedById: actor.id } });
  }
}
