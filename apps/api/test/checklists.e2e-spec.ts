/** Phase 4 — ChecklistSubmission / ChecklistResponse, Invariant #21, cross-tenant (§8). */
import { createTenant, createTestApp, expectCrossTenantNotFound, resetDatabase, Tenant, TestContext } from './harness';
import { PNG_1PX, sopHelpers } from './sop-helpers';

let ctx: TestContext;
let a: Tenant;
let b: Tenant;
const h = sopHelpers(() => ctx);
const as = h.as;

beforeAll(async () => {
  ctx = await createTestApp();
  await resetDatabase(ctx.prisma);
  a = await createTenant(ctx, 'alpha');
  b = await createTenant(ctx, 'beta');
});
afterAll(() => ctx.close());

async function checklistSop(t: Tenant) {
  return h.publishedSop(t, {
    name: 'Daily press check',
    config: { checklist_sop: true },
    steps: [
      { description: 'Guards in place', isCritical: true },
      { description: 'Oil level' },
    ],
  });
}

function start(t: Tenant, sopId: string, role: 'OPERATOR' | 'EDITOR' = 'OPERATOR') {
  return ctx.http().post('/api/checklists').set(as(t, role)).send({ sopId });
}

describe('checklist execution', () => {
  it('only SOPs configured as checklists can be started', async () => {
    const { sopId } = await h.publishedSop(a, { name: 'Not a checklist' });
    await start(a, sopId).expect(400);
  });

  it('operator starts, answers every step, completes', async () => {
    const { sopId, versionId } = await checklistSop(a);
    const s = await start(a, sopId).expect(201);
    expect(s.body.version.id).toBe(versionId);
    expect(s.body.status).toBe('in_progress');
    const [s1, s2] = s.body.version.steps;

    await ctx.http().post(`/api/checklists/${s.body.id}/complete`).set(as(a, 'OPERATOR')).expect(400);
    await ctx.http().put(`/api/checklists/${s.body.id}/responses/${s1.id}`).set(as(a, 'OPERATOR')).send({ result: 'ok' }).expect(200);

    const up = await ctx.http().post(`/api/checklists/${s.body.id}/media`).set(as(a, 'OPERATOR')).attach('file', PNG_1PX, { filename: 'oil.png', contentType: 'image/png' }).expect(201);
    const r = await ctx
      .http()
      .put(`/api/checklists/${s.body.id}/responses/${s2.id}`)
      .set(as(a, 'OPERATOR'))
      .send({ result: 'not_ok', comment: 'Low', mediaAssetId: up.body.id })
      .expect(200);
    expect(r.body.responses).toHaveLength(2);
    expect((await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: up.body.id } })).lifecycleState).toBe('referenced');

    const done = await ctx.http().post(`/api/checklists/${s.body.id}/complete`).set(as(a, 'OPERATOR')).expect(200);
    expect(done.body.status).toBe('completed');
    await ctx.http().put(`/api/checklists/${s.body.id}/responses/${s1.id}`).set(as(a, 'OPERATOR')).send({ result: 'not_ok' }).expect(409);

    const list = await ctx.http().get(`/api/checklists?sopId=${sopId}`).set(as(a, 'EDITOR')).expect(200);
    expect(list.body[0]).toMatchObject({ status: 'completed', answered: 2, totalSteps: 2, notOk: 1 });
  });

  it('a step from a different version is rejected', async () => {
    const { sopId } = await checklistSop(a);
    const other = await checklistSop(a);
    const otherStep = await ctx.prisma.sopStep.findFirstOrThrow({ where: { sopVersionId: other.versionId } });
    const s = await start(a, sopId).expect(201);
    await ctx.http().put(`/api/checklists/${s.body.id}/responses/${otherStep.id}`).set(as(a, 'OPERATOR')).send({ result: 'ok' }).expect(400);
  });

  it('only the starting operator can fill it; operators only see their own; supervisors see all', async () => {
    const { sopId } = await checklistSop(a);
    const s = await start(a, sopId).expect(201);
    const step = s.body.version.steps[0];
    const otherOp = await a.addUser('OPERATOR', 'op2');
    await ctx.http().get(`/api/checklists/${s.body.id}`).set(otherOp.auth).expect(404);
    await ctx.http().put(`/api/checklists/${s.body.id}/responses/${step.id}`).set(otherOp.auth).send({ result: 'ok' }).expect(404);
    await ctx.http().get(`/api/checklists/${s.body.id}`).set(as(a, 'EDITOR')).expect(200);
    await ctx.http().put(`/api/checklists/${s.body.id}/responses/${step.id}`).set(as(a, 'EDITOR')).send({ result: 'ok' }).expect(403);
    const mine = await ctx.http().get('/api/checklists').set(otherOp.auth).expect(200);
    expect(mine.body).toEqual([]);
  });

  it('abandon ends the submission', async () => {
    const { sopId } = await checklistSop(a);
    const s = await start(a, sopId).expect(201);
    const r = await ctx.http().post(`/api/checklists/${s.body.id}/abandon`).set(as(a, 'OPERATOR')).expect(200);
    expect(r.body.status).toBe('abandoned');
  });
});

describe('Invariant #21 — execution-version pinning', () => {
  it('publishing a newer version never changes an in-progress or completed submission', async () => {
    const { sopId, versionId: v1 } = await checklistSop(a);
    const inProgress = await start(a, sopId).expect(201);
    const completed = await start(a, sopId).expect(201);
    for (const st of completed.body.version.steps) {
      await ctx.http().put(`/api/checklists/${completed.body.id}/responses/${st.id}`).set(as(a, 'OPERATOR')).send({ result: 'ok' }).expect(200);
    }
    await ctx.http().post(`/api/checklists/${completed.body.id}/complete`).set(as(a, 'OPERATOR')).expect(200);

    const v2 = await h.republish(a, sopId, [{ description: 'Brand new step A' }, { description: 'B' }, { description: 'C' }]);
    expect(v2).not.toBe(v1);

    for (const id of [inProgress.body.id, completed.body.id]) {
      const row = await ctx.prisma.checklistSubmission.findUniqueOrThrow({ where: { id } });
      expect(row.sopVersionId).toBe(v1);
      const view = await ctx.http().get(`/api/checklists/${id}`).set(as(a, 'OPERATOR')).expect(200);
      expect(view.body.version.id).toBe(v1);
      expect(view.body.version.steps).toHaveLength(2);
    }
    const completedResponses = await ctx.prisma.checklistResponse.count({ where: { submissionId: completed.body.id } });
    expect(completedResponses).toBe(2);

    // the in-progress run continues against v1's steps, not v2's
    const v1Step = inProgress.body.version.steps[0];
    await ctx.http().put(`/api/checklists/${inProgress.body.id}/responses/${v1Step.id}`).set(as(a, 'OPERATOR')).send({ result: 'ok' }).expect(200);
    const v2Step = await ctx.prisma.sopStep.findFirstOrThrow({ where: { sopVersionId: v2 } });
    await ctx.http().put(`/api/checklists/${inProgress.body.id}/responses/${v2Step.id}`).set(as(a, 'OPERATOR')).send({ result: 'ok' }).expect(400);

    // new runs use v2
    const fresh = await start(a, sopId).expect(201);
    expect(fresh.body.version.id).toBe(v2);
  });
});

describe('cross-tenant isolation — checklists (§8 Phase 4)', () => {
  it('tenant B cannot start on, read, answer, complete or list tenant A’s checklists', async () => {
    const { sopId } = await checklistSop(a);
    const s = await start(a, sopId).expect(201);
    const step = s.body.version.steps[0];
    const B = as(b, 'OWNER');
    await expectCrossTenantNotFound(() => ctx.http().post('/api/checklists').set(B).send({ sopId }));
    await expectCrossTenantNotFound(() => ctx.http().get(`/api/checklists/${s.body.id}`).set(B));
    await expectCrossTenantNotFound(() => ctx.http().put(`/api/checklists/${s.body.id}/responses/${step.id}`).set(B).send({ result: 'ok' }));
    await expectCrossTenantNotFound(() => ctx.http().post(`/api/checklists/${s.body.id}/complete`).set(B));
    await expectCrossTenantNotFound(() => ctx.http().post(`/api/checklists/${s.body.id}/abandon`).set(B));
    await expectCrossTenantNotFound(() =>
      ctx.http().post(`/api/checklists/${s.body.id}/media`).set(B).attach('file', PNG_1PX, { filename: 'x.png', contentType: 'image/png' }),
    );
    const list = await ctx.http().get('/api/checklists').set(B).expect(200);
    expect(list.body.map((x: { id: string }) => x.id)).not.toContain(s.body.id);

    // B cannot attach A's media to B's own checklist
    const bSop = await checklistSop(b);
    const bRun = await start(b, bSop.sopId).expect(201);
    const aMedia = await ctx.http().post(`/api/checklists/${s.body.id}/media`).set(as(a, 'OPERATOR')).attach('file', PNG_1PX, { filename: 'a.png', contentType: 'image/png' }).expect(201);
    await ctx
      .http()
      .put(`/api/checklists/${bRun.body.id}/responses/${bRun.body.version.steps[0].id}`)
      .set(as(b, 'OPERATOR'))
      .send({ result: 'ok', mediaAssetId: aMedia.body.id })
      .expect(400);
  });
});
