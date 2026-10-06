import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { Permission } from '../common/permissions';
import { PrismaService } from '../prisma/prisma.service';

const DAY = 86_400_000;

/**
 * §4.6 Analytics derived from ActivityEvent. Owner/Admin see the whole org;
 * Editors see only their own activity (§7.2 "Editor: own activity").
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(actor: AuthUser, q: { from?: string; to?: string }) {
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * DAY);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw new BadRequestException('Invalid date range');
    if (to.getTime() - from.getTime() > 366 * DAY) throw new BadRequestException('Date range may not exceed one year');

    const ownOnly = !actor.permissions.has(Permission.AnalyticsViewAll);
    const scope = Prisma.sql`organization_id = ${actor.organizationId}::uuid AND occurred_at >= ${from} AND occurred_at <= ${to}
      ${ownOnly ? Prisma.sql`AND actor_id = ${actor.id}::uuid` : Prisma.empty}`;

    const [byType, daily, topSops, topActors] = await Promise.all([
      this.prisma.$queryRaw<{ event_type: string; n: bigint }[]>`
        SELECT event_type, COUNT(*) AS n FROM activity_event WHERE ${scope} GROUP BY event_type ORDER BY n DESC`,
      this.prisma.$queryRaw<{ day: Date; views: bigint; edits: bigint; created: bigint; checklists: bigint }[]>`
        SELECT date_trunc('day', occurred_at) AS day,
          COUNT(*) FILTER (WHERE event_type = 'sop.viewed') AS views,
          COUNT(*) FILTER (WHERE event_type IN ('sop.edited', 'sop.version.created')) AS edits,
          COUNT(*) FILTER (WHERE event_type IN ('sop.created', 'kanban.created')) AS created,
          COUNT(*) FILTER (WHERE event_type = 'checklist.completed') AS checklists
        FROM activity_event WHERE ${scope} GROUP BY 1 ORDER BY 1`,
      this.prisma.$queryRaw<{ entity_id: string; n: bigint }[]>`
        SELECT entity_id, COUNT(*) AS n FROM activity_event
        WHERE ${scope} AND event_type = 'sop.viewed' AND entity_id IS NOT NULL
        GROUP BY entity_id ORDER BY n DESC LIMIT 10`,
      ownOnly
        ? Promise.resolve([] as { actor_id: string; n: bigint }[])
        : this.prisma.$queryRaw<{ actor_id: string; n: bigint }[]>`
            SELECT actor_id, COUNT(*) AS n FROM activity_event
            WHERE ${scope} AND actor_id IS NOT NULL AND event_type <> 'user.login'
            GROUP BY actor_id ORDER BY n DESC LIMIT 10`,
    ]);

    const [sops, actors, totals] = await Promise.all([
      this.prisma.sop.findMany({
        where: { organizationId: actor.organizationId, id: { in: topSops.map((t) => t.entity_id).filter((id) => /^[0-9a-f-]{36}$/i.test(id)) } },
        select: { id: true, name: true, referenceNo: true },
      }),
      this.prisma.user.findMany({
        where: { organizationId: actor.organizationId, id: { in: topActors.map((t) => t.actor_id) } },
        select: { id: true, name: true },
      }),
      this.totals(actor, ownOnly),
    ]);
    const sopById = new Map(sops.map((s) => [s.id, s]));
    const actorById = new Map(actors.map((a) => [a.id, a]));

    return {
      scope: ownOnly ? 'own' : 'organization',
      from,
      to,
      totals,
      events: byType.map((r) => ({ eventType: r.event_type, count: Number(r.n) })),
      daily: daily.map((d) => ({
        day: d.day,
        views: Number(d.views),
        edits: Number(d.edits),
        created: Number(d.created),
        checklists: Number(d.checklists),
      })),
      topSops: topSops.filter((t) => sopById.has(t.entity_id)).map((t) => ({ sop: sopById.get(t.entity_id)!, views: Number(t.n) })),
      topActors: topActors.filter((t) => actorById.has(t.actor_id)).map((t) => ({ user: actorById.get(t.actor_id)!, events: Number(t.n) })),
    };
  }

  private async totals(actor: AuthUser, ownOnly: boolean) {
    const org = actor.organizationId;
    const mine = ownOnly ? { createdById: actor.id } : {};
    const [byStatus, kanbans, users, checklists] = await Promise.all([
      this.prisma.sop.groupBy({ by: ['status'], where: { organizationId: org, deletedAt: null, ...mine }, _count: { _all: true } }),
      this.prisma.kanban.count({ where: { organizationId: org, deletedAt: null, ...mine } }),
      ownOnly ? Promise.resolve(null) : this.prisma.user.count({ where: { organizationId: org, status: 'active' } }),
      this.prisma.checklistSubmission.count({ where: { organizationId: org, status: 'completed', ...(ownOnly ? { operatorId: actor.id } : {}) } }),
    ]);
    return {
      sopsByStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
      kanbans,
      activeUsers: users,
      completedChecklists: checklists,
    };
  }
}
