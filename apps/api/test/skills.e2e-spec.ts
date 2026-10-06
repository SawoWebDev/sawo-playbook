/**
 * Phase 7 — Skills Matrix: SkillAssessment + SkillRecord single-transaction rule
 * (§6.8), Invariant #7 version pinning, field-level visibility (§7.2), cross-tenant (§8).
 */
import { SkillsService } from '../src/skills/skills.service';
import { createTenant, createTestApp, expectCrossTenantNotFound, resetDatabase, Tenant, TenantUser, TestContext } from './harness';
import { sopHelpers } from './sop-helpers';

let ctx: TestContext;
let a: Tenant;
let b: Tenant;
let sopId: string;
let v1: string;
let trainee: TenantUser;
let other: TenantUser;
const h = sopHelpers(() => ctx);
const as = h.as;

beforeAll(async () => {
  ctx = await createTestApp();
  await resetDatabase(ctx.prisma);
  a = await createTenant(ctx, 'alpha');
  b = await createTenant(ctx, 'beta');
  ({ sopId, versionId: v1 } = await h.publishedSop(a, { name: 'Weld bracket' }));
  trainee = a.users.OPERATOR;
  other = await a.addUser('OPERATOR', 'other-op');
  await ctx.http().post('/api/skills/trainers').set(as(a, 'ADMIN')).send({ trainerId: a.users.EDITOR.user.id, associateId: trainee.user.id }).expect(201);
});
afterAll(() => ctx.close());

const assess = (auth: { Authorization: string }, body: object) => ctx.http().post('/api/skills/assessments').set(auth).send(body);

describe('trainer assignment', () => {
  it('only Owner/Admin assign; the trainer must hold skills.update (not a role name)', async () => {
    await ctx.http().post('/api/skills/trainers').set(as(a, 'EDITOR')).send({ trainerId: a.users.EDITOR.user.id, associateId: other.user.id }).expect(403);
    await ctx.http().post('/api/skills/trainers').set(as(a, 'ADMIN')).send({ trainerId: a.users.OPERATOR.user.id, associateId: other.user.id }).expect(400);
    await ctx.http().post('/api/skills/trainers').set(as(a, 'ADMIN')).send({ trainerId: a.users.EDITOR.user.id, associateId: trainee.user.id }).expect(409); // already assigned in beforeAll
    const list = await ctx.http().get('/api/skills/trainers').set(as(a, 'ADMIN')).expect(200);
    expect(list.body.map((x: { associate: { id: string } }) => x.associate.id)).toEqual([trainee.user.id]);
  });
});

describe('assessments', () => {
  it('Editor records training → SkillAssessment + SkillRecord pinned to the published version', async () => {
    const r = await assess(as(a, 'EDITOR'), { associateId: trainee.user.id, sopId, level: 2, notes: 'Good progress' }).expect(201);
    expect(r.body.sopVersionId).toBe(v1);
    const rec = await ctx.prisma.skillRecord.findUniqueOrThrow({ where: { associateId_sopId: { associateId: trainee.user.id, sopId } } });
    expect(rec).toMatchObject({ currentLevel: 2, currentSopVersionId: v1, lastAssessmentId: r.body.id });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'skills.assessed', entityId: r.body.id } })).toBe(1);
  });

  it('nobody can assess themselves', async () => {
    await assess(as(a, 'EDITOR'), { associateId: a.users.EDITOR.user.id, sopId, level: 1 }).expect(403);
    await assess(as(a, 'ADMIN'), { associateId: a.users.ADMIN.user.id, sopId, level: 1 }).expect(403);
  });

  it('Viewers, Pre Approvers and the retired Trainer role cannot assess; levels outside 0–4 are rejected', async () => {
    await assess(as(a, 'OPERATOR'), { associateId: other.user.id, sopId, level: 1 }).expect(403);
    await assess(as(a, 'PRE_APPROVER'), { associateId: trainee.user.id, sopId, level: 1 }).expect(403);
    await assess(as(a, 'TRAINER'), { associateId: trainee.user.id, sopId, level: 1 }).expect(403);
    await assess(as(a, 'ADMIN'), { associateId: other.user.id, sopId, level: 5 }).expect(400);
  });

  it('cannot assess against a draft version', async () => {
    const d = await ctx.http().post(`/api/sops/${sopId}/versions`).set(as(a, 'EDITOR')).expect(201);
    await assess(as(a, 'ADMIN'), { associateId: other.user.id, sopId, level: 1, sopVersionId: d.body.id }).expect(400);
    await ctx.http().post(`/api/sops/${sopId}/versions/${d.body.id}/abandon`).set(as(a, 'EDITOR')).expect(200);
  });

  it('Invariant #7: history keeps the exact version; a newer publish marks the cell outdated', async () => {
    await assess(as(a, 'ADMIN'), { associateId: other.user.id, sopId, level: 3 }).expect(201);
    const v2 = await h.republish(a, sopId, [{ description: 'Revised step' }]);
    let m = await ctx.http().get('/api/skills/matrix').set(as(a, 'ADMIN')).expect(200);
    let cell = m.body.cells.find((c: { associateId: string; sopId: string }) => c.associateId === other.user.id && c.sopId === sopId);
    expect(cell).toMatchObject({ level: 3, sopVersionId: v1, outdated: true });

    await assess(as(a, 'ADMIN'), { associateId: other.user.id, sopId, level: 4 }).expect(201);
    m = await ctx.http().get('/api/skills/matrix').set(as(a, 'ADMIN')).expect(200);
    cell = m.body.cells.find((c: { associateId: string; sopId: string }) => c.associateId === other.user.id && c.sopId === sopId);
    expect(cell).toMatchObject({ level: 4, sopVersionId: v2, outdated: false });

    const hist = await ctx.http().get(`/api/skills/history?associateId=${other.user.id}&sopId=${sopId}`).set(as(a, 'ADMIN')).expect(200);
    expect(hist.body.map((x: { level: number; sopVersionId: string }) => [x.level, x.sopVersionId])).toEqual([
      [4, v2],
      [3, v1],
    ]);
  });

  it('MANDATORY single-transaction rule: if the SkillRecord projection fails, the assessment is rolled back', async () => {
    const svc = ctx.app.get(SkillsService);
    const before = await ctx.prisma.skillAssessment.count();
    const spy = jest.spyOn(svc, 'projectRecord').mockRejectedValueOnce(new Error('projection failed'));
    try {
      await assess(as(a, 'ADMIN'), { associateId: other.user.id, sopId, level: 0 }).expect(500);
    } finally {
      spy.mockRestore();
    }
    expect(await ctx.prisma.skillAssessment.count()).toBe(before);
    const rec = await ctx.prisma.skillRecord.findUniqueOrThrow({ where: { associateId_sopId: { associateId: other.user.id, sopId } } });
    expect(rec.currentLevel).toBe(4);
  });

  it('repair rebuilds SkillRecord rows from history after drift', async () => {
    await ctx.prisma.skillRecord.update({
      where: { associateId_sopId: { associateId: other.user.id, sopId } },
      data: { currentLevel: 0 },
    });
    await ctx.http().post('/api/skills/rebuild').set(as(a, 'TRAINER')).expect(403);
    const r = await ctx.http().post('/api/skills/rebuild').set(as(a, 'OWNER')).expect(200);
    expect(r.body.rebuilt).toBeGreaterThanOrEqual(2);
    const rec = await ctx.prisma.skillRecord.findUniqueOrThrow({ where: { associateId_sopId: { associateId: other.user.id, sopId } } });
    expect(rec.currentLevel).toBe(4);
  });
});

describe('field-level visibility (§7.2)', () => {
  it('Viewer sees only their own row (read-only); Editor and Admin see and edit everyone', async () => {
    const op = await ctx.http().get('/api/skills/matrix').set(trainee.auth).expect(200);
    expect(op.body.associates.map((x: { id: string }) => x.id)).toEqual([trainee.user.id]);
    expect(op.body.associates[0].editable).toBe(false);
    const ed = await ctx.http().get('/api/skills/matrix').set(as(a, 'EDITOR')).expect(200);
    expect(ed.body.associates.length).toBeGreaterThanOrEqual(7);
    expect(ed.body.associates.find((x: { id: string }) => x.id === trainee.user.id).editable).toBe(true);
    expect(ed.body.associates.find((x: { id: string }) => x.id === a.users.EDITOR.user.id).editable).toBe(false); // not self
    const ad = await ctx.http().get('/api/skills/matrix').set(as(a, 'ADMIN')).expect(200);
    expect(ad.body.associates.length).toBeGreaterThanOrEqual(7);
    await ctx.http().get('/api/skills/matrix').set(as(a, 'TRAINER')).expect(403); // retired role
  });

  it('Operator cannot read another associate’s history', async () => {
    await ctx.http().get(`/api/skills/history?associateId=${other.user.id}`).set(trainee.auth).expect(404);
    const own = await ctx.http().get('/api/skills/history').set(trainee.auth).expect(200);
    expect(own.body.every((x: { associate: { id: string } }) => x.associate.id === trainee.user.id)).toBe(true);
  });
});

describe('cross-tenant isolation — skills (§8 Phase 7)', () => {
  it('tenant B cannot assess, read, or assign across tenants', async () => {
    const B = as(b, 'OWNER');
    await expectCrossTenantNotFound(() => assess(B, { associateId: trainee.user.id, sopId, level: 1 }));
    const bOp = b.users.OPERATOR.user.id;
    await expectCrossTenantNotFound(() => assess(B, { associateId: bOp, sopId, level: 1 })); // A's SOP
    await expectCrossTenantNotFound(() => ctx.http().post('/api/skills/trainers').set(B).send({ trainerId: a.users.TRAINER.user.id, associateId: bOp }));
    await expectCrossTenantNotFound(() => ctx.http().delete(`/api/skills/trainers/${a.users.TRAINER.user.id}/${trainee.user.id}`).set(B));
    const m = await ctx.http().get('/api/skills/matrix').set(B).expect(200);
    expect(m.body.sops.map((s: { id: string }) => s.id)).not.toContain(sopId);
    expect(m.body.associates.map((x: { id: string }) => x.id)).not.toContain(trainee.user.id);
    const hist = await ctx.http().get(`/api/skills/history?associateId=${trainee.user.id}`).set(B).expect(200);
    expect(hist.body).toEqual([]);
    const r = await ctx.http().post('/api/skills/rebuild').set(B).expect(200);
    expect(r.body.rebuilt).toBe(0);
    expect(await ctx.prisma.skillRecord.count({ where: { organizationId: a.organizationId } })).toBeGreaterThan(0);
  });
});
