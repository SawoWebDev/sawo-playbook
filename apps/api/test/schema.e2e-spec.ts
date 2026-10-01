/**
 * Phase 0 migration/DB tests (§16 Phase 0 items 5–6, §17 mandatory concurrency test).
 * These talk to Postgres directly — no feature behaviour exists yet.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { isUniqueViolation } from '../src/prisma/prisma.service';
import { createTenant, createTestApp, resetDatabase, Tenant, TestContext } from './harness';

let ctx: TestContext;
let tenant: Tenant;

beforeAll(async () => {
  ctx = await createTestApp();
  await resetDatabase(ctx.prisma);
  tenant = await createTenant(ctx, 'schema');
});
afterAll(() => ctx.close());

async function makeSop(organizationId = tenant.organizationId) {
  return ctx.prisma.sop.create({
    data: {
      organizationId,
      referenceNo: `REF-${Math.random().toString(36).slice(2, 10)}`,
      name: 'Test SOP',
      qrPublicToken: Math.random().toString(36).slice(2) + Date.now(),
      createdById: tenant.users.EDITOR.user.id,
    },
  });
}

function versionData(sopId: string, seq: number, state: Prisma.SopVersionCreateManyInput['lifecycleState'] = 'DRAFT') {
  return {
    organizationId: tenant.organizationId,
    sopId,
    versionSequence: seq,
    lifecycleState: state,
    createdById: tenant.users.EDITOR.user.id,
  };
}

describe('OrganizationSettings defaults (§6.1a)', () => {
  it('creates defaults quorum=3, allow_self_approval=false, public_sop_viewing=false', async () => {
    const s = await ctx.prisma.organizationSettings.findUniqueOrThrow({
      where: { organizationId: tenant.organizationId },
    });
    expect(s.approvalQuorum).toBe(3);
    expect(s.allowSelfApproval).toBe(false);
    expect(s.publicSopViewing).toBe(false);
  });

  it('rejects a quorum below 1', async () => {
    await expect(
      ctx.prisma.organizationSettings.update({
        where: { organizationId: tenant.organizationId },
        data: { approvalQuorum: 0 },
      }),
    ).rejects.toThrow();
  });
});

describe('Invariant #19 — one active unpublished version per SOP (partial unique index)', () => {
  it('rejects a second active version sequentially', async () => {
    const sop = await makeSop();
    await ctx.prisma.sopVersion.create({ data: versionData(sop.id, 1) });
    const err = await ctx.prisma.sopVersion
      .create({ data: versionData(sop.id, 2) })
      .catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
  });

  it('exactly one of two CONCURRENT create-draft inserts succeeds', async () => {
    const sop = await makeSop();
    // Two independent connections so the inserts genuinely race.
    const a = new PrismaClient();
    const b = new PrismaClient();
    try {
      await Promise.all([a.$connect(), b.$connect()]);
      const results = await Promise.allSettled([
        a.sopVersion.create({ data: versionData(sop.id, 1) }),
        b.sopVersion.create({ data: versionData(sop.id, 2) }),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(isUniqueViolation(failed[0].reason)).toBe(true);
    } finally {
      await Promise.all([a.$disconnect(), b.$disconnect()]);
    }
  });

  it('allows a new draft once the previous one is PUBLISHED or ABANDONED', async () => {
    const sop = await makeSop();
    const v1 = await ctx.prisma.sopVersion.create({ data: versionData(sop.id, 1) });
    await ctx.prisma.sopVersion.update({ where: { id: v1.id }, data: { lifecycleState: 'PUBLISHED' } });
    const v2 = await ctx.prisma.sopVersion.create({ data: versionData(sop.id, 2) });
    await ctx.prisma.sopVersion.update({ where: { id: v2.id }, data: { lifecycleState: 'ABANDONED' } });
    await expect(ctx.prisma.sopVersion.create({ data: versionData(sop.id, 3) })).resolves.toBeTruthy();
  });

  it('PENDING_APPROVAL and APPROVED also count as active', async () => {
    for (const state of ['PENDING_APPROVAL', 'APPROVED'] as const) {
      const sop = await makeSop();
      await ctx.prisma.sopVersion.create({ data: versionData(sop.id, 1, state) });
      const err = await ctx.prisma.sopVersion.create({ data: versionData(sop.id, 2) }).catch((e: unknown) => e);
      expect(isUniqueViolation(err)).toBe(true);
    }
  });

  it('version_sequence is unique per SOP', async () => {
    const sop = await makeSop();
    await ctx.prisma.sopVersion.create({ data: versionData(sop.id, 1, 'PUBLISHED') });
    const err = await ctx.prisma.sopVersion.create({ data: versionData(sop.id, 1, 'PUBLISHED') }).catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
  });
});

describe('SOPVersionApproval (§6.4)', () => {
  async function pendingVersion() {
    const sop = await makeSop();
    return ctx.prisma.sopVersion.create({ data: versionData(sop.id, 1, 'PENDING_APPROVAL') });
  }

  function approve(sopVersionId: string, approverId: string, round: number, decision: 'approved' | 'rejected' = 'approved') {
    return ctx.prisma.sopVersionApproval.create({
      data: { organizationId: tenant.organizationId, sopVersionId, approverId, approvalRound: round, decision },
    });
  }

  async function quorumCount(versionId: string): Promise<number> {
    const [row] = await ctx.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(DISTINCT a.approver_id) AS n
      FROM sop_version_approval a
      JOIN sop_version v ON v.id = a.sop_version_id
      WHERE a.sop_version_id = ${versionId}::uuid
        AND a.decision = 'approved'
        AND a.approval_round = v.current_approval_round`;
    return Number(row.n);
  }

  it('prevents double-voting by the same approver in the same round', async () => {
    const v = await pendingVersion();
    await approve(v.id, tenant.users.APPROVER.user.id, 1);
    const err = await approve(v.id, tenant.users.APPROVER.user.id, 1, 'rejected').catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
  });

  it('allows the same approver to vote again in a new round', async () => {
    const v = await pendingVersion();
    await approve(v.id, tenant.users.APPROVER.user.id, 1);
    await expect(approve(v.id, tenant.users.APPROVER.user.id, 2)).resolves.toBeTruthy();
  });

  it('approval-round isolation: prior-round approvals do not count toward the new round (Invariant #17)', async () => {
    const v = await pendingVersion();
    await approve(v.id, tenant.users.APPROVER.user.id, 1);
    await approve(v.id, tenant.users.ADMIN.user.id, 1);
    expect(await quorumCount(v.id)).toBe(2);

    // reject → resubmit increments the round
    await approve(v.id, tenant.users.OWNER.user.id, 1, 'rejected');
    await ctx.prisma.sopVersion.update({ where: { id: v.id }, data: { currentApprovalRound: 2 } });
    expect(await quorumCount(v.id)).toBe(0);

    await approve(v.id, tenant.users.APPROVER.user.id, 2);
    expect(await quorumCount(v.id)).toBe(1);

    // Round-1 decisions remain as immutable history.
    expect(await ctx.prisma.sopVersionApproval.count({ where: { sopVersionId: v.id, approvalRound: 1 } })).toBe(3);
  });

  it('approval decisions are immutable (no UPDATE / DELETE)', async () => {
    const v = await pendingVersion();
    const a = await approve(v.id, tenant.users.APPROVER.user.id, 1);
    await expect(
      ctx.prisma.sopVersionApproval.update({ where: { id: a.id }, data: { decision: 'rejected' } }),
    ).rejects.toThrow(/immutable/);
    await expect(ctx.prisma.sopVersionApproval.delete({ where: { id: a.id } })).rejects.toThrow(/immutable/);
  });
});

describe('Media join tables (§6.6a)', () => {
  async function asset() {
    return ctx.prisma.mediaAsset.create({
      data: {
        organizationId: tenant.organizationId,
        type: 'image',
        storageKey: `k/${Math.random()}`,
        originalFilename: 'a.png',
        mimeType: 'image/png',
        sizeBytes: 10n,
        createdById: tenant.users.EDITOR.user.id,
      },
    });
  }

  it('SOPStepMedia: composite PK prevents attaching the same asset twice to one step', async () => {
    const sop = await makeSop();
    const v = await ctx.prisma.sopVersion.create({ data: versionData(sop.id, 1) });
    const step = await ctx.prisma.sopStep.create({
      data: { organizationId: tenant.organizationId, sopVersionId: v.id, order: 1 },
    });
    const m = await asset();
    await ctx.prisma.sopStepMedia.create({ data: { sopStepId: step.id, mediaAssetId: m.id, displayOrder: 0 } });
    const err = await ctx.prisma.sopStepMedia
      .create({ data: { sopStepId: step.id, mediaAssetId: m.id, displayOrder: 1 } })
      .catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
  });

  it('one asset can be referenced by steps of multiple versions (orphan detection is a join query)', async () => {
    const sop = await makeSop();
    const m = await asset();
    const v1 = await ctx.prisma.sopVersion.create({ data: versionData(sop.id, 1) });
    const s1 = await ctx.prisma.sopStep.create({ data: { organizationId: tenant.organizationId, sopVersionId: v1.id, order: 1 } });
    await ctx.prisma.sopStepMedia.create({ data: { sopStepId: s1.id, mediaAssetId: m.id } });
    await ctx.prisma.sopVersion.update({ where: { id: v1.id }, data: { lifecycleState: 'PUBLISHED' } });
    const v2 = await ctx.prisma.sopVersion.create({ data: versionData(sop.id, 2) });
    const s2 = await ctx.prisma.sopStep.create({ data: { organizationId: tenant.organizationId, sopVersionId: v2.id, order: 1 } });
    await ctx.prisma.sopStepMedia.create({ data: { sopStepId: s2.id, mediaAssetId: m.id } });
    expect(await ctx.prisma.sopStepMedia.count({ where: { mediaAssetId: m.id } })).toBe(2);
  });

  it('KanbanMedia: composite PK prevents duplicates', async () => {
    const k = await ctx.prisma.kanban.create({
      data: {
        organizationId: tenant.organizationId,
        partCode: 'P-1',
        orderingType: 'email',
        orderingEmail: 'buy@example.com',
        createdById: tenant.users.EDITOR.user.id,
      },
    });
    const m = await asset();
    await ctx.prisma.kanbanMedia.create({ data: { kanbanId: k.id, mediaAssetId: m.id } });
    const err = await ctx.prisma.kanbanMedia.create({ data: { kanbanId: k.id, mediaAssetId: m.id } }).catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
  });
});

describe('Kanban ordering constraint (§6.7)', () => {
  const base = () => ({
    organizationId: tenant.organizationId,
    partCode: 'P',
    createdById: tenant.users.EDITOR.user.id,
  });

  it('accepts ordering_type=url without ordering_url (the URL is optional); sop/email still need their target', async () => {
    await expect(ctx.prisma.kanban.create({ data: { ...base(), orderingType: 'url' } })).resolves.toBeTruthy();
    await expect(ctx.prisma.kanban.create({ data: { ...base(), orderingType: 'sop' } })).rejects.toThrow();
    await expect(ctx.prisma.kanban.create({ data: { ...base(), orderingType: 'email' } })).rejects.toThrow();
  });

  it('rejects two ordering targets at once', async () => {
    await expect(
      ctx.prisma.kanban.create({
        data: { ...base(), orderingType: 'url', orderingUrl: 'https://x', orderingEmail: 'a@b.c' },
      }),
    ).rejects.toThrow();
  });

  it('accepts a matching single target', async () => {
    await expect(
      ctx.prisma.kanban.create({ data: { ...base(), orderingType: 'url', orderingUrl: 'https://x' } }),
    ).resolves.toBeTruthy();
  });
});

describe('Skills constraints (§6.8)', () => {
  it('rejects levels outside 0–4 and forbids in-place updates of assessments', async () => {
    const sop = await makeSop();
    const v = await ctx.prisma.sopVersion.create({ data: versionData(sop.id, 1, 'PUBLISHED') });
    const data = {
      organizationId: tenant.organizationId,
      associateId: tenant.users.OPERATOR.user.id,
      sopId: sop.id,
      sopVersionId: v.id,
      trainerId: tenant.users.TRAINER.user.id,
    };
    await expect(ctx.prisma.skillAssessment.create({ data: { ...data, level: 5 } })).rejects.toThrow();
    const a = await ctx.prisma.skillAssessment.create({ data: { ...data, level: 2 } });
    await expect(ctx.prisma.skillAssessment.update({ where: { id: a.id }, data: { level: 3 } })).rejects.toThrow(/immutable/);
  });
});

describe('AuditLog immutability (Invariant #11)', () => {
  it('blocks UPDATE and DELETE', async () => {
    const row = await ctx.prisma.auditLog.create({
      data: { organizationId: tenant.organizationId, action: 'test.event' },
    });
    await expect(ctx.prisma.auditLog.update({ where: { id: row.id }, data: { action: 'tampered' } })).rejects.toThrow(/immutable/);
    await expect(ctx.prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/immutable/);
  });

  it('allows DELETE only inside the purge workflow flag', async () => {
    const row = await ctx.prisma.auditLog.create({ data: { action: 'test.purgeable' } });
    await ctx.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('gemba.allow_purge', 'on', true)`;
      await tx.auditLog.delete({ where: { id: row.id } });
    });
    expect(await ctx.prisma.auditLog.findUnique({ where: { id: row.id } })).toBeNull();
  });
});
