import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { canSeeUnpublished } from '../sops/sops.service';
import { versionLabel } from '../sops/sop-status';

/** Turns free text into a safe prefix tsquery: "brg 62" → "brg:* & 62:*". */
export function toPrefixQuery(input: string): string | null {
  const terms = (input.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8);
  return terms.length ? terms.map((t) => `${t}:*`).join(' & ') : null;
}

/**
 * §14 PostgreSQL FTS. SOPs match on name / reference / folder name and on the
 * CURRENT PUBLISHED version's step titles & descriptions; draft content is
 * searched only for users who may see drafts. Soft-deleted rows are excluded.
 */
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(actor: AuthUser, q: string, limit = 20) {
    const query = toPrefixQuery(q);
    if (!query) return { sops: [], kanbans: [] };
    const drafts = canSeeUnpublished(actor);

    const sops = await this.prisma.$queryRaw<
      { id: string; name: string; reference_no: string; status: string; seq: number | null; rank: number; in_meta: boolean; in_published: boolean; in_draft: boolean }[]
    >`
      WITH q AS (SELECT to_tsquery('simple', ${query}) AS query)
      SELECT s.id, s.name, s.reference_no, s.status, pv.version_sequence AS seq,
        (coalesce(s.search_tsv @@ q.query, false)) AS in_meta,
        (coalesce(pv.content_tsv @@ q.query, false)) AS in_published,
        (coalesce(dv.content_tsv @@ q.query, false)) AS in_draft,
        (ts_rank(coalesce(s.search_tsv, ''::tsvector), q.query) * 2
          + ts_rank(coalesce(pv.content_tsv, ''::tsvector), q.query)
          + ts_rank(coalesce(dv.content_tsv, ''::tsvector), q.query) * 0.5)::float8 AS rank
      FROM sop s
      CROSS JOIN q
      LEFT JOIN sop_version pv ON pv.id = s.current_published_version_id
      LEFT JOIN sop_version dv ON dv.id = s.latest_draft_version_id AND ${drafts}::boolean
      WHERE s.organization_id = ${actor.organizationId}::uuid
        AND s.deleted_at IS NULL
        ${drafts ? Prisma.empty : Prisma.sql`AND s.current_published_version_id IS NOT NULL AND s.archived_at IS NULL`}
        AND (s.search_tsv @@ q.query OR pv.content_tsv @@ q.query OR dv.content_tsv @@ q.query)
      ORDER BY rank DESC, s.name
      LIMIT ${limit}`;

    const kanbans = await this.prisma.$queryRaw<{ id: string; part_code: string; part_description: string | null; supplier: string | null; rank: number }[]>`
      SELECT k.id, k.part_code, k.part_description, k.supplier, ts_rank(k.search_tsv, to_tsquery('simple', ${query}))::float8 AS rank
      FROM kanban k
      WHERE k.organization_id = ${actor.organizationId}::uuid AND k.deleted_at IS NULL
        AND k.search_tsv @@ to_tsquery('simple', ${query})
      ORDER BY rank DESC, k.part_code
      LIMIT ${limit}`;

    return {
      sops: sops.map((s) => ({
        id: s.id,
        name: s.name,
        referenceNo: s.reference_no,
        status: s.status,
        publishedVersionLabel: s.seq ? versionLabel(s.seq) : null,
        matchedIn: [s.in_meta && 'title', s.in_published && 'published content', s.in_draft && 'draft content'].filter(Boolean),
      })),
      kanbans: kanbans.map((k) => ({ id: k.id, partCode: k.part_code, partDescription: k.part_description, supplier: k.supplier })),
    };
  }
}
