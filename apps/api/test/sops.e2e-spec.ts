/**
 * Phase 1 (SOP MVP) + Phase 1.5 (governance) — including the mandatory
 * standing suites of §17: published-immutability regression at every layer,
 * Invariant #19 concurrency via the API, approval-round isolation, and
 * cross-tenant isolation for SOP / version / step / media / QR / approvals.
 */
import { OrgRole } from '@prisma/client';
import { canTransitionMedia, MEDIA_TRANSITIONS } from '../src/media/media-lifecycle';
import { ImmutableVersionError, SopVersionRepository } from '../src/sops/sop-version.repository';
import { deriveSopStatus } from '../src/sops/sop-status';
import {
  createTenant,
  createTestApp,
  expectCrossTenantNotFound,
  refreshAuth,
  resetDatabase,
  Tenant,
  TestContext,
} from './harness';

// 1×1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let ctx: TestContext;
let a: Tenant;
let b: Tenant;

beforeAll(async () => {
  ctx = await createTestApp();
  await resetDatabase(ctx.prisma);
  a = await createTenant(ctx, 'alpha');
  b = await createTenant(ctx, 'beta');
});
afterAll(() => ctx.close());

const as = (t: Tenant, role: OrgRole) => t.users[role].auth;

async function upload(t: Tenant, buf = PNG, name = 'photo.png', type = 'image/png') {
  const res = await ctx.http().post('/api/media').set(as(t, 'EDITOR')).attach('file', buf, { filename: name, contentType: type });
  return res;
}

async function createSop(t: Tenant, name = 'Change the filter') {
  const res = await ctx.http().post('/api/sops').set(as(t, 'EDITOR')).send({ name }).expect(201);
  return { sopId: res.body.id as string, versionId: res.body.activeVersionId as string, body: res.body };
}

async function saveSteps(t: Tenant, sopId: string, versionId: string, steps: object[], role: OrgRole = 'EDITOR') {
  return ctx.http().put(`/api/sops/${sopId}/versions/${versionId}/steps`).set(as(t, role)).send({ steps });
}

/** Drives a version through submit → quorum approvals → publish. Quorum is 3 by default. */
async function publishFlow(t: Tenant, sopId: string, versionId: string) {
  await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
  await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/pre-approve`).set(as(t, 'PRE_APPROVER')).send({}).expect(200);
  for (const auth of [t.reviewer.auth, as(t, 'ADMIN'), as(t, 'OWNER')]) {
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/decisions`).set(auth).send({ decision: 'approved' }).expect(200);
  }
  await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/publish`).set(as(t, 'ADMIN')).expect(200);
}

async function publishedSop(t: Tenant, name = 'Published SOP') {
  const { sopId, versionId } = await createSop(t, name);
  const m = await upload(t);
  await saveSteps(t, sopId, versionId, [
    { title: 'Isolate', description: '<p>Lock out</p>', plannedTimeSeconds: 30, isCritical: true, media: [{ mediaAssetId: m.body.id }] },
    { description: '<p>Replace filter</p>', plannedTimeSeconds: 90 },
  ]).then((r) => expect(r.status).toBe(200));
  await publishFlow(t, sopId, versionId);
  return { sopId, versionId, mediaId: m.body.id as string };
}

// ─────────────────────────── Phase 1 ───────────────────────────

describe('SOP creation (§17 worked example)', () => {
  it('Editor creates SOP + SOPVersion(version_sequence=1, DRAFT)', async () => {
    const { sopId, body } = await createSop(a);
    expect(body.status).toBe('draft');
    expect(body.referenceNo).toMatch(/^SOP-\d{4}$/);
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]).toMatchObject({ versionSequence: 1, lifecycleState: 'DRAFT', label: '1.001' });
    const sop = await ctx.prisma.sop.findUniqueOrThrow({ where: { id: sopId } });
    expect(sop.organizationId).toBe(a.organizationId);
    expect(sop.qrPublicToken.length).toBeGreaterThanOrEqual(20);
  });

  it.each(['OPERATOR', 'TRAINER', 'PRE_APPROVER'] as const)('%s cannot create (403)', async (role) => {
    await ctx.http().post('/api/sops').set(as(a, role)).send({ name: 'x' }).expect(403);
  });

  it('ignores/rejects client-supplied organizationId', async () => {
    await ctx.http().post('/api/sops').set(as(a, 'EDITOR')).send({ name: 'x', organizationId: b.organizationId }).expect(400);
  });

  it('steps are ordered, sanitised, and cycle time = sum of planned times', async () => {
    const { sopId, versionId } = await createSop(a);
    const res = await saveSteps(a, sopId, versionId, [
      { description: '<p>one</p><script>alert(1)</script>', plannedTimeSeconds: 10 },
      { description: '<p onclick="x()">two <a href="javascript:alert(1)">bad</a></p>', plannedTimeSeconds: 20 },
      { description: 'three', plannedTimeSeconds: 30 },
    ]).then((r) => (expect(r.status).toBe(200), r));
    expect(res.body.steps.map((s: { order: number }) => s.order)).toEqual([1, 2, 3]);
    expect(res.body.cycleTimeSeconds).toBe(60);
    expect(res.body.steps[0].description).not.toMatch(/script/);
    expect(res.body.steps[1].description).not.toMatch(/onclick|javascript/);

    // reorder + reopen
    const reordered = [res.body.steps[2], res.body.steps[0]].map((s: { id: string; description: string }) => ({ id: s.id, description: s.description }));
    const r2 = await saveSteps(a, sopId, versionId, reordered);
    expect(r2.body.steps.map((s: { description: string }) => s.description)).toEqual(['three', '<p>one</p>']);
    expect(r2.body.steps[0].id).toBe(res.body.steps[2].id);
    const reopened = await ctx.http().get(`/api/sops/${sopId}/versions/${versionId}`).set(as(a, 'EDITOR')).expect(200);
    expect(reopened.body.steps).toHaveLength(2);
  });

  it('keeps text colour / highlight but strips every other style', async () => {
    const { sopId, versionId } = await createSop(a);
    const res = await saveSteps(a, sopId, versionId, [
      {
        description:
          '<p><span style="color: #b42318">red</span> <span style="background-color: rgb(255, 241, 199)">hi</span> ' +
          '<span style="position: fixed; background-image: url(javascript:x)">bad</span> <span style="color: expression(alert(1))">x</span></p>',
      },
    ]).then((r) => (expect(r.status).toBe(200), r));
    const html = res.body.steps[0].description as string;
    expect(html).toContain('color:#b42318');
    expect(html).toContain('background-color:rgb(255, 241, 199)');
    expect(html).not.toMatch(/position|background-image|javascript|expression/);
  });

  it('SOP type can be switched between standard and advanced', async () => {
    const { sopId } = await createSop(a);
    const r = await ctx.http().patch(`/api/sops/${sopId}`).set(as(a, 'EDITOR')).send({ type: 'advanced' }).expect(200);
    expect(r.body.type).toBe('advanced');
    await ctx.http().patch(`/api/sops/${sopId}`).set(as(a, 'EDITOR')).send({ type: 'video' }).expect(400);
  });

  it('Operator → 403 on step save', async () => {
    const { sopId, versionId } = await createSop(a);
    const r = await saveSteps(a, sopId, versionId, [{ description: 'x' }], 'OPERATOR');
    expect(r.status).toBe(403);
  });

  it('Viewers (OPERATOR) see published SOPs and drafts, read-only', async () => {
    const { sopId: draftId, versionId } = await createSop(a, 'Draft only');
    const { sopId: pubId } = await publishedSop(a, 'Visible to all');
    const ed = await ctx.http().get('/api/sops?limit=200').set(as(a, 'EDITOR')).expect(200);
    const op = await ctx.http().get('/api/sops?limit=200').set(as(a, 'OPERATOR')).expect(200);
    const ids = (r: { body: { items: { id: string }[] } }) => r.body.items.map((i) => i.id);
    expect(ids(ed)).toEqual(expect.arrayContaining([draftId, pubId]));
    expect(ids(op)).toEqual(expect.arrayContaining([draftId, pubId]));
    await ctx.http().get(`/api/sops/${draftId}`).set(as(a, 'OPERATOR')).expect(200);
    await ctx.http().get(`/api/sops/${draftId}/versions/${versionId}`).set(as(a, 'OPERATOR')).expect(200);
    // ...but cannot change anything
    expect((await saveSteps(a, draftId, versionId, [{ description: 'x' }], 'OPERATOR')).status).toBe(403);
    await ctx.http().patch(`/api/sops/${draftId}`).set(as(a, 'OPERATOR')).send({ name: 'renamed' }).expect(403);
    await ctx.http().post(`/api/sops/${draftId}/versions/${versionId}/finish`).set(as(a, 'OPERATOR')).send({}).expect(403);
    await ctx.http().delete(`/api/sops/${draftId}`).set(as(a, 'OPERATOR')).expect(403);
  });

  it('search filters by name / reference', async () => {
    await createSop(a, 'Unique Zebra Procedure');
    const r = await ctx.http().get('/api/sops?search=zebra').set(as(a, 'EDITOR')).expect(200);
    expect(r.body.items.map((i: { name: string }) => i.name)).toEqual(['Unique Zebra Procedure']);
  });
});

describe('media upload (§7.8)', () => {
  it('accepts a real PNG and returns a signed URL', async () => {
    const r = await upload(a);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ type: 'image', mimeType: 'image/png', width: 1, height: 1 });
    expect(r.body.url).toMatch(/^\/api\/files\/.+sig=/);
    const file = await ctx.http().get(r.body.url).expect(200);
    expect(file.headers['content-type']).toBe('image/png');
    await ctx.http().get(r.body.url.replace(/sig=[^&]+/, 'sig=bad')).expect(404);
  });

  it('rejects content that is not what it claims to be', async () => {
    const r = await upload(a, Buffer.from('<html><script>alert(1)</script></html>'), 'x.png', 'image/png');
    expect(r.status).toBe(400);
  });

  it('cannot attach another tenant’s media (IDOR)', async () => {
    const foreign = await upload(b);
    const { sopId, versionId } = await createSop(a);
    const r = await saveSteps(a, sopId, versionId, [{ description: 'x', media: [{ mediaAssetId: foreign.body.id }] }]);
    expect(r.status).toBe(400);
    await expectCrossTenantNotFound(() => ctx.http().get(`/api/media/${foreign.body.id}`).set(as(a, 'OWNER')));
  });
});

// ─────────────────────────── Phase 1.5 ───────────────────────────

describe('approval state machine (§6.3)', () => {
  it('full happy path: DRAFT → PENDING → APPROVED (quorum) → PUBLISHED', async () => {
    const { sopId, versionId } = await createSop(a);
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/submit`).set(as(a, 'EDITOR')).send({}).expect(400); // no steps
    await saveSteps(a, sopId, versionId, [{ description: 'Do it' }]);
    const sub = await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/submit`).set(as(a, 'EDITOR')).send({ changeSummary: 'first' }).expect(200);
    expect(sub.body.lifecycleState).toBe('PENDING_PRE_APPROVAL');
    expect((await ctx.prisma.sop.findUniqueOrThrow({ where: { id: sopId } })).status).toBe('pending_approval');

    // steps are frozen while under review
    expect((await saveSteps(a, sopId, versionId, [{ description: 'sneaky' }])).status).toBe(409);
    // pre-approval comes first: a Pre Approver cannot give the final decision, and must pre-approve
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/decisions`).set(as(a, 'PRE_APPROVER')).send({ decision: 'approved' }).expect(403);
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/pre-approve`).set(as(a, 'PRE_APPROVER')).send({}).expect(200);
    expect((await ctx.prisma.sopVersion.findUniqueOrThrow({ where: { id: versionId } })).lifecycleState).toBe('PENDING_APPROVAL');

    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/decisions`).set(a.reviewer.auth).send({ decision: 'approved' }).expect(200);
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/decisions`).set(as(a, 'ADMIN')).send({ decision: 'approved' }).expect(200);
    let v = await ctx.prisma.sopVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(v.lifecycleState).toBe('PENDING_APPROVAL');
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/decisions`).set(as(a, 'OWNER')).send({ decision: 'approved' }).expect(200);
    v = await ctx.prisma.sopVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(v.lifecycleState).toBe('APPROVED');
    expect((await ctx.prisma.sop.findUniqueOrThrow({ where: { id: sopId } })).status).toBe('approved');

    // Viewers, Pre Approvers and Editors cannot publish; an Approver (publish permission) can
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/publish`).set(as(a, 'OPERATOR')).expect(403);
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/publish`).set(as(a, 'PRE_APPROVER')).expect(403);
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/publish`).set(as(a, 'EDITOR')).expect(403);
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/publish`).set(as(a, 'APPROVER')).expect(200);
    const sop = await ctx.prisma.sop.findUniqueOrThrow({ where: { id: sopId } });
    expect(sop.status).toBe('published');
    expect(sop.currentPublishedVersionId).toBe(versionId);
    expect(sop.latestDraftVersionId).toBeNull();
    const actions = (await ctx.prisma.auditLog.findMany({ where: { entityId: versionId }, select: { action: true } })).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['sop.version.submitted', 'sop.version.approved', 'sop.version.published']));
  });

  it('Viewers and Pre Approvers cannot approve; the submitter cannot self-approve; publishing a non-APPROVED version is 409', async () => {
    const { sopId, versionId } = await createSop(a);
    await saveSteps(a, sopId, versionId, [{ description: 'x' }]);
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/submit`).set(as(a, 'EDITOR')).send({}).expect(200);
    for (const role of ['OPERATOR', 'PRE_APPROVER', 'TRAINER'] as const) {
      await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/decisions`).set(as(a, role)).send({ decision: 'approved' }).expect(403);
    }
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/decisions`).set(as(a, 'EDITOR')).send({ decision: 'approved' }).expect(403); // own submission
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/publish`).set(as(a, 'ADMIN')).expect(409);
  });

  it('self-approval is blocked by default and allowed when the org enables it (Invariant #14)', async () => {
    const { sopId, versionId } = await createSop(a);
    await saveSteps(a, sopId, versionId, [{ description: 'x' }]);
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/submit`).set(as(a, 'ADMIN')).send({}).expect(200);
    // the submitter may not pre-approve their own submission
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/pre-approve`).set(as(a, 'ADMIN')).send({}).expect(403);

    await ctx.prisma.organizationSettings.update({ where: { organizationId: a.organizationId }, data: { allowSelfApproval: true } });
    try {
      await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/pre-approve`).set(as(a, 'ADMIN')).send({}).expect(200);
      await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/decisions`).set(as(a, 'ADMIN')).send({ decision: 'approved' }).expect(200);
    } finally {
      await ctx.prisma.organizationSettings.update({ where: { organizationId: a.organizationId }, data: { allowSelfApproval: false } });
    }
  });

  it('an approver cannot vote twice in the same round (409)', async () => {
    const { sopId, versionId } = await createSop(a);
    await saveSteps(a, sopId, versionId, [{ description: 'x' }]);
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/submit`).set(as(a, 'EDITOR')).send({}).expect(200);
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/pre-approve`).set(as(a, 'PRE_APPROVER')).send({}).expect(200);
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/decisions`).set(a.reviewer.auth).send({ decision: 'approved' }).expect(200);
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/decisions`).set(a.reviewer.auth).send({ decision: 'approved' }).expect(409);
  });

  it('MANDATORY approval-round isolation: reject → resubmit → prior approvals do not count', async () => {
    const { sopId, versionId } = await createSop(a);
    await saveSteps(a, sopId, versionId, [{ description: 'x' }]);
    const url = `/api/sops/${sopId}/versions/${versionId}`;
    await ctx.http().post(`${url}/submit`).set(as(a, 'EDITOR')).send({}).expect(200);
    await ctx.http().post(`${url}/pre-approve`).set(as(a, 'PRE_APPROVER')).send({}).expect(200);
    await ctx.http().post(`${url}/decisions`).set(a.reviewer.auth).send({ decision: 'approved' }).expect(200);
    await ctx.http().post(`${url}/decisions`).set(as(a, 'ADMIN')).send({ decision: 'approved' }).expect(200);
    await ctx.http().post(`${url}/decisions`).set(as(a, 'OWNER')).send({ decision: 'rejected' }).expect(400); // comment required
    const rej = await ctx.http().post(`${url}/decisions`).set(as(a, 'OWNER')).send({ decision: 'rejected', comment: 'Missing PPE step' }).expect(200);
    expect(rej.body.lifecycleState).toBe('DRAFT');
    const listed = await ctx.http().get('/api/sops?limit=200').set(as(a, 'EDITOR')).expect(200);
    expect(listed.body.items.find((i: { id: string }) => i.id === sopId).activeVersion.rejected).toBe(true);

    await saveSteps(a, sopId, versionId, [{ description: 'Wear PPE' }, { description: 'x' }]);
    const resub = await ctx.http().post(`${url}/submit`).set(as(a, 'EDITOR')).send({}).expect(200);
    expect(resub.body.currentApprovalRound).toBe(2);
    await ctx.http().post(`${url}/pre-approve`).set(as(a, 'PRE_APPROVER')).send({}).expect(200);

    // one new approval in round 2 must not reach quorum even though round 1 had two approvals
    await ctx.http().post(`${url}/decisions`).set(a.reviewer.auth).send({ decision: 'approved' }).expect(200);
    const hist = await ctx.http().get(`${url}/approvals`).set(as(a, 'EDITOR')).expect(200);
    expect(hist.body.approvedInCurrentRound).toBe(1);
    // round 1 holds the pre-approval, two final approvals and the rejection
    expect(hist.body.decisions.filter((d: { round: number }) => d.round === 1)).toHaveLength(4);
    expect((await ctx.prisma.sopVersion.findUniqueOrThrow({ where: { id: versionId } })).lifecycleState).toBe('PENDING_APPROVAL');

    await ctx.http().post(`${url}/decisions`).set(as(a, 'ADMIN')).send({ decision: 'approved' }).expect(200);
    await ctx.http().post(`${url}/decisions`).set(as(a, 'OWNER')).send({ decision: 'approved' }).expect(200);
    expect((await ctx.prisma.sopVersion.findUniqueOrThrow({ where: { id: versionId } })).lifecycleState).toBe('APPROVED');
  });

  it('Invariant #20: a valid decision still counts after the approver is demoted; demoted user cannot vote', async () => {
    const t = await createTenant(ctx, 'inv20');
    const extra = await t.addUser('APPROVER', 'approver3');
    const { sopId, versionId } = await createSop(t);
    await saveSteps(t, sopId, versionId, [{ description: 'x' }]);
    const url = `/api/sops/${sopId}/versions/${versionId}`;
    await ctx.http().post(`${url}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    await ctx.http().post(`${url}/pre-approve`).set(as(t, 'PRE_APPROVER')).send({}).expect(200);
    await ctx.http().post(`${url}/decisions`).set(t.reviewer.auth).send({ decision: 'approved' }).expect(200);

    // demote the first approver to Viewer
    await ctx.http().patch(`/api/users/${t.reviewer.user.id}/role`).set(as(t, 'OWNER')).send({ role: 'OPERATOR' }).expect(200);
    const demoted = await refreshAuth(ctx, t.reviewer);
    // the second approver (still eligible) and admin complete the quorum — the demoted user's earlier vote counts
    await ctx.http().post(`${url}/decisions`).set(extra.auth).send({ decision: 'approved' }).expect(200);
    await ctx.http().post(`${url}/decisions`).set(as(t, 'ADMIN')).send({ decision: 'approved' }).expect(200);
    expect((await ctx.prisma.sopVersion.findUniqueOrThrow({ where: { id: versionId } })).lifecycleState).toBe('APPROVED');

    // a demoted user cannot submit new decisions
    const { sopId: s2, versionId: v2 } = await createSop(t);
    await saveSteps(t, s2, v2, [{ description: 'x' }]);
    await ctx.http().post(`/api/sops/${s2}/versions/${v2}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    await ctx.http().post(`/api/sops/${s2}/versions/${v2}/decisions`).set(demoted.auth).send({ decision: 'approved' }).expect(403);
  });
});

describe('publishing without approval (org setting approval_required=false, the default)', () => {
  it('Finish & Save publishes a draft directly; editing again creates a new version', async () => {
    const t = await createTenant(ctx, 'noapproval');
    expect((await ctx.prisma.organizationSettings.findUniqueOrThrow({ where: { organizationId: t.organizationId } })).approvalRequired).toBe(false);
    const { sopId, versionId } = await createSop(t);
    // Editors can edit but cannot publish, even when approval is off (sop.publish is required; see sop-finish-authz.e2e-spec).
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/finish`).set(as(t, 'EDITOR')).send({}).expect(403);
    await saveSteps(t, sopId, versionId, [{ description: 'Do it' }]);
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/finish`).set(as(t, 'OPERATOR')).send({}).expect(403);
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/finish`).set(as(t, 'EDITOR')).send({ changeSummary: 'v1' }).expect(403);
    const r = await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/finish`).set(as(t, 'APPROVER')).send({ changeSummary: 'v1' }).expect(200);
    expect(r.body.lifecycleState).toBe('PUBLISHED');
    const sop = await ctx.prisma.sop.findUniqueOrThrow({ where: { id: sopId } });
    expect(sop).toMatchObject({ status: 'published', currentPublishedVersionId: versionId });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'sop.version.published', entityId: versionId } })).toBe(1);
    // published content is immutable; a new edit is a new version
    expect((await saveSteps(t, sopId, versionId, [{ description: 'tamper' }])).status).toBe(409);
    const v2 = await ctx.http().post(`/api/sops/${sopId}/versions`).set(as(t, 'EDITOR')).expect(201);
    await saveSteps(t, sopId, v2.body.id, [{ description: 'Do it better' }]);
    await ctx.http().post(`/api/sops/${sopId}/versions/${v2.body.id}/finish`).set(as(t, 'EDITOR')).send({}).expect(403);
    await ctx.http().post(`/api/sops/${sopId}/versions/${v2.body.id}/finish`).set(as(t, 'APPROVER')).send({}).expect(200);
    expect((await ctx.prisma.sop.findUniqueOrThrow({ where: { id: sopId } })).currentPublishedVersionId).toBe(v2.body.id);
  });

  it('when the organization requires approval, finish is refused', async () => {
    const t = await createTenant(ctx, 'approval');
    await ctx.http().patch('/api/organization/settings').set(as(t, 'OWNER')).send({ approvalRequired: true }).expect(200);
    const { sopId, versionId } = await createSop(t);
    await saveSteps(t, sopId, versionId, [{ description: 'x' }]);
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/finish`).set(as(t, 'EDITOR')).send({}).expect(403);
  });

  it('cross-tenant finish is 404', async () => {
    const { sopId, versionId } = await createSop(a);
    await saveSteps(a, sopId, versionId, [{ description: 'x' }]);
    await expectCrossTenantNotFound(() => ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/finish`).set(as(b, 'OWNER')).send({}));
  });
});

describe('MANDATORY published-version immutability regression (§10) — every layer', () => {
  let sopId: string;
  let versionId: string;

  beforeAll(async () => {
    ({ sopId, versionId } = await publishedSop(a, 'Immutable'));
  });

  it('layer 1 — service/API rejects step and config edits (409)', async () => {
    expect((await saveSteps(a, sopId, versionId, [{ description: 'tamper' }], 'OWNER')).status).toBe(409);
    await ctx.http().patch(`/api/sops/${sopId}/versions/${versionId}`).set(as(a, 'OWNER')).send({ changeSummary: 'tamper' }).expect(409);
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/abandon`).set(as(a, 'OWNER')).expect(409);
  });

  it('layer 2 — repository independently refuses the write', async () => {
    const repo = ctx.app.get(SopVersionRepository);
    await expect(
      ctx.prisma.$transaction((tx) =>
        repo.replaceSteps(tx, { id: versionId, sopId, organizationId: a.organizationId, lifecycleState: 'DRAFT' /* lie */ }, []),
      ),
    ).rejects.toBeInstanceOf(ImmutableVersionError);
  });

  it('layer 3 — database triggers reject UPDATE/DELETE/INSERT on published content', async () => {
    const step = await ctx.prisma.sopStep.findFirstOrThrow({ where: { sopVersionId: versionId } });
    await expect(ctx.prisma.sopStep.update({ where: { id: step.id }, data: { description: 'tamper' } })).rejects.toThrow(/immutable/);
    await expect(ctx.prisma.sopStep.delete({ where: { id: step.id } })).rejects.toThrow(/immutable/);
    await expect(
      ctx.prisma.sopStep.create({ data: { organizationId: a.organizationId, sopVersionId: versionId, order: 99 } }),
    ).rejects.toThrow(/immutable/);
    await expect(ctx.prisma.sopStepMedia.deleteMany({ where: { sopStepId: step.id } })).rejects.toThrow(/immutable/);
    await expect(ctx.prisma.sopVersion.update({ where: { id: versionId }, data: { changeSummary: 'tamper' } })).rejects.toThrow(/immutable/);
    await expect(ctx.prisma.sopVersion.update({ where: { id: versionId }, data: { lifecycleState: 'DRAFT' } })).rejects.toThrow(/immutable/);
    await expect(ctx.prisma.sopVersion.delete({ where: { id: versionId } })).rejects.toThrow(/cannot be deleted/);
    const after = await ctx.prisma.sopStep.findUniqueOrThrow({ where: { id: step.id } });
    expect(after.description).toBe(step.description);
  });
});

describe('copy-on-write versions + Invariant #19 via the API', () => {
  it('editing a published SOP creates version 2 with copied steps and media; v1 is untouched', async () => {
    const { sopId, versionId, mediaId } = await publishedSop(a, 'CoW');
    const r = await ctx.http().post(`/api/sops/${sopId}/versions`).set(as(a, 'EDITOR')).expect(201);
    expect(r.body).toMatchObject({ versionSequence: 2, lifecycleState: 'DRAFT', label: '1.002' });
    expect(r.body.steps).toHaveLength(2);
    expect(r.body.steps[0].media[0].id).toBe(mediaId);
    expect(r.body.steps[0].id).not.toBe((await ctx.prisma.sopStep.findFirstOrThrow({ where: { sopVersionId: versionId, order: 1 } })).id);
    const sop = await ctx.prisma.sop.findUniqueOrThrow({ where: { id: sopId } });
    expect(sop.status).toBe('draft');
    expect(sop.currentPublishedVersionId).toBe(versionId);

    // Viewers still get v1 as the current (published) version; they can open the draft read-only
    const cur = await ctx.http().get(`/api/sops/${sopId}/current`).set(as(a, 'OPERATOR')).expect(200);
    expect(cur.body.id).toBe(versionId);
    await ctx.http().get(`/api/sops/${sopId}/versions/${r.body.id}`).set(as(a, 'OPERATOR')).expect(200);
  });

  it('MANDATORY concurrency: two simultaneous create-draft requests → exactly one 201, one 409', async () => {
    const { sopId } = await publishedSop(a, 'Race');
    const results = await Promise.all([
      ctx.http().post(`/api/sops/${sopId}/versions`).set(as(a, 'EDITOR')),
      ctx.http().post(`/api/sops/${sopId}/versions`).set(as(a, 'ADMIN')),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await ctx.prisma.sopVersion.count({ where: { sopId, lifecycleState: 'DRAFT' } })).toBe(1);
  });

  it('abandoning a draft frees the SOP for a new version and restores status=published', async () => {
    const { sopId } = await publishedSop(a, 'Abandon');
    const d = await ctx.http().post(`/api/sops/${sopId}/versions`).set(as(a, 'EDITOR')).expect(201);
    await ctx.http().post(`/api/sops/${sopId}/versions`).set(as(a, 'EDITOR')).expect(409);
    const ab = await ctx.http().post(`/api/sops/${sopId}/versions/${d.body.id}/abandon`).set(as(a, 'EDITOR')).expect(200);
    expect(ab.body.status).toBe('published');
    await ctx.http().post(`/api/sops/${sopId}/versions`).set(as(a, 'EDITOR')).expect(201);
  });
});

describe('duplicate SOP', () => {
  it('creates a new draft SOP with copied config, steps and media; the source is untouched', async () => {
    const { sopId, versionId, mediaId } = await publishedSop(a, 'Original');
    const r = await ctx.http().post(`/api/sops/${sopId}/duplicate`).set(as(a, 'EDITOR')).expect(201);
    expect(r.body).toMatchObject({ name: 'Original (Copy)', status: 'draft' });
    expect(r.body.id).not.toBe(sopId);
    expect(r.body.referenceNo).not.toBe((await ctx.prisma.sop.findUniqueOrThrow({ where: { id: sopId } })).referenceNo);
    const v = await ctx.http().get(`/api/sops/${r.body.id}/versions/${r.body.activeVersionId}`).set(as(a, 'EDITOR')).expect(200);
    expect(v.body).toMatchObject({ versionSequence: 1, lifecycleState: 'DRAFT' });
    expect(v.body.steps.map((s: { plannedTimeSeconds: number }) => s.plannedTimeSeconds)).toEqual([30, 90]);
    expect(v.body.steps[0].media[0].id).toBe(mediaId);
    expect(await ctx.prisma.sopStep.count({ where: { sopVersionId: versionId } })).toBe(2);
  });

  it('copies an open draft in preference to the published version', async () => {
    const { sopId } = await publishedSop(a, 'Has draft');
    const d = await ctx.http().post(`/api/sops/${sopId}/versions`).set(as(a, 'EDITOR')).expect(201);
    await saveSteps(a, sopId, d.body.id, [{ description: '<p>Only step</p>', plannedTimeSeconds: 5 }]).then((x) => expect(x.status).toBe(200));
    const r = await ctx.http().post(`/api/sops/${sopId}/duplicate`).set(as(a, 'EDITOR')).expect(201);
    const v = await ctx.http().get(`/api/sops/${r.body.id}/versions/${r.body.activeVersionId}`).set(as(a, 'EDITOR')).expect(200);
    expect(v.body.steps).toHaveLength(1);
  });

  it('a never-published duplicate can be deleted; it disappears from the list and its draft is abandoned', async () => {
    const { sopId } = await publishedSop(a, 'Keep me');
    const copy = await ctx.http().post(`/api/sops/${sopId}/duplicate`).set(as(a, 'EDITOR')).expect(201);
    await ctx.http().delete(`/api/sops/${copy.body.id}`).set(as(a, 'OPERATOR')).expect(403);
    await ctx.http().delete(`/api/sops/${copy.body.id}`).set(as(b, 'EDITOR')).expect(404);
    await ctx.http().delete(`/api/sops/${copy.body.id}`).set(as(a, 'EDITOR')).expect(204);
    await ctx.http().get(`/api/sops/${copy.body.id}`).set(as(a, 'EDITOR')).expect(404);
    const list = await ctx.http().get('/api/sops?search=Keep%20me').set(as(a, 'EDITOR')).expect(200);
    expect(list.body.items.map((s: { id: string }) => s.id)).toEqual([sopId]);
    const v = await ctx.prisma.sopVersion.findUniqueOrThrow({ where: { id: copy.body.activeVersionId } });
    expect(v.lifecycleState).toBe('ABANDONED');
  });

  it('a published SOP with nothing in progress cannot be deleted (409)', async () => {
    const { sopId } = await publishedSop(a, 'Published, not deletable');
    await ctx.http().delete(`/api/sops/${sopId}`).set(as(a, 'EDITOR')).expect(409);
    await ctx.http().get(`/api/sops/${sopId}`).set(as(a, 'EDITOR')).expect(200);
  });

  it('an SOP with a draft in progress is deleted entirely, even if an earlier version was published', async () => {
    const { sopId, versionId } = await publishedSop(a, 'Draft again');
    const d = await ctx.http().post(`/api/sops/${sopId}/versions`).set(as(a, 'EDITOR')).expect(201);
    await ctx.http().delete(`/api/sops/${sopId}`).set(as(a, 'EDITOR')).expect(204);
    await ctx.http().get(`/api/sops/${sopId}`).set(as(a, 'EDITOR')).expect(404);
    expect((await ctx.prisma.sopVersion.findUniqueOrThrow({ where: { id: d.body.id } })).lifecycleState).toBe('ABANDONED');
    expect((await ctx.prisma.sopVersion.findUniqueOrThrow({ where: { id: versionId } })).lifecycleState).toBe('PUBLISHED');
  });

  it('Operator cannot duplicate (403); cross-tenant is 404', async () => {
    const { sopId } = await publishedSop(a, 'Guarded');
    await ctx.http().post(`/api/sops/${sopId}/duplicate`).set(as(a, 'OPERATOR')).expect(403);
    await ctx.http().post(`/api/sops/${sopId}/duplicate`).set(as(b, 'EDITOR')).expect(404);
  });
});

describe('SOP.status derivation (Invariant #18)', () => {
  it.each([
    [{ archived: true, activeState: 'DRAFT', hasPublished: true }, 'archived'],
    [{ archived: false, activeState: 'PENDING_APPROVAL', hasPublished: true }, 'pending_approval'],
    [{ archived: false, activeState: 'APPROVED', hasPublished: false }, 'approved'],
    [{ archived: false, activeState: 'DRAFT', hasPublished: true }, 'draft'],
    [{ archived: false, activeState: null, hasPublished: true }, 'published'],
    [{ archived: false, activeState: null, hasPublished: false }, 'draft'],
  ] as const)('%j → %s', (input, expected) => {
    expect(deriveSopStatus(input)).toBe(expected);
  });
});

describe('MediaAsset lifecycle (§6.6)', () => {
  it('graph: only the documented transitions are legal; purged is terminal', () => {
    expect(canTransitionMedia('uploaded', 'attached')).toBe(true);
    expect(canTransitionMedia('orphaned', 'attached')).toBe(true);
    expect(canTransitionMedia('soft_deleted', 'attached')).toBe(false);
    expect(canTransitionMedia('uploaded', 'referenced')).toBe(false);
    expect(canTransitionMedia('referenced', 'attached')).toBe(false);
    expect(MEDIA_TRANSITIONS.purged).toEqual([]);
  });

  it('uploaded → attached (draft) → referenced (publish); removing it from a later draft keeps it referenced', async () => {
    const { sopId, mediaId } = await publishedSop(a, 'Media');
    expect((await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } })).lifecycleState).toBe('referenced');
    const d = await ctx.http().post(`/api/sops/${sopId}/versions`).set(as(a, 'EDITOR')).expect(201);
    await saveSteps(a, sopId, d.body.id, [{ description: 'no media now' }]);
    expect((await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } })).lifecycleState).toBe('referenced');
  });

  it('attached → orphaned when removed from its only draft; orphaned → attached when re-used', async () => {
    const { sopId, versionId } = await createSop(a);
    const m = await upload(a);
    expect((await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: m.body.id } })).lifecycleState).toBe('uploaded');
    await saveSteps(a, sopId, versionId, [{ description: 'x', media: [{ mediaAssetId: m.body.id }] }]);
    expect((await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: m.body.id } })).lifecycleState).toBe('attached');
    await saveSteps(a, sopId, versionId, [{ description: 'x' }]);
    const orphan = await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: m.body.id } });
    expect(orphan.lifecycleState).toBe('orphaned');
    expect(orphan.orphanedAt).not.toBeNull();
    await saveSteps(a, sopId, versionId, [{ description: 'x', media: [{ mediaAssetId: m.body.id }] }]);
    expect((await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: m.body.id } })).lifecycleState).toBe('attached');
  });

  it('abandoning a draft orphans media only it referenced', async () => {
    const { sopId, versionId } = await createSop(a);
    const m = await upload(a);
    await saveSteps(a, sopId, versionId, [{ description: 'x', media: [{ mediaAssetId: m.body.id }] }]);
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/abandon`).set(as(a, 'EDITOR')).expect(200);
    expect((await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: m.body.id } })).lifecycleState).toBe('orphaned');
  });
});

describe('QR resolver (§5)', () => {
  it('resolves to the SOP; requires auth by default; never exposes drafts', async () => {
    const { sopId } = await publishedSop(a, 'QR SOP');
    const token = (await ctx.prisma.sop.findUniqueOrThrow({ where: { id: sopId } })).qrPublicToken;
    const r = await ctx.http().get(`/api/qr/${token}`).expect(200);
    expect(r.body).toEqual({ sopId, requiresAuth: true, hasPublishedVersion: true });
    await ctx.http().get('/api/qr/does-not-exist-token-000').expect(404);
    const png = await ctx.http().get(`/api/qr/${token}/image.png`).expect(200);
    expect(png.headers['content-type']).toBe('image/png');
  });

  it('with public viewing enabled returns the CURRENT published version — and follows new publishes', async () => {
    const t = await createTenant(ctx, 'qrpublic');
    await ctx.prisma.organizationSettings.update({ where: { organizationId: t.organizationId }, data: { publicSopViewing: true } });
    const { sopId, versionId } = await publishedSop(t, 'Public QR');
    const token = (await ctx.prisma.sop.findUniqueOrThrow({ where: { id: sopId } })).qrPublicToken;
    const r1 = await ctx.http().get(`/api/qr/${token}`).expect(200);
    expect(r1.body.version.id).toBe(versionId);

    const d = await ctx.http().post(`/api/sops/${sopId}/versions`).set(as(t, 'EDITOR')).expect(201);
    const still = await ctx.http().get(`/api/qr/${token}`).expect(200);
    expect(still.body.version.id).toBe(versionId); // drafts never leak

    await publishFlow(t, sopId, d.body.id);
    const r2 = await ctx.http().get(`/api/qr/${token}`).expect(200);
    expect(r2.body.version.id).toBe(d.body.id);
    expect(r2.body.version.versionSequence).toBe(2);
  });

  it('QR edit intent: a user of another org who scans the code still gets 404 on every SOP endpoint', async () => {
    const { sopId } = await publishedSop(a, 'QR edit');
    await expectCrossTenantNotFound(() => ctx.http().post(`/api/sops/${sopId}/versions`).set(as(b, 'OWNER')));
    await expectCrossTenantNotFound(() => ctx.http().get(`/api/sops/${sopId}/current`).set(as(b, 'OWNER')));
  });
});

describe('PDF export', () => {
  it('renders a PDF for a published version', async () => {
    const { sopId, versionId } = await publishedSop(a, 'Print SOP');
    const r = await ctx.http().get(`/api/sops/${sopId}/versions/${versionId}/print`).set(as(a, 'OPERATOR')).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect((r.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  }, 60_000);
});

describe('bulk import / export (CSV)', () => {
  it('import is all-or-nothing and reports row errors', async () => {
    const bad = 'name,type\nOK-1,standard\n,standard\nOK-2,not-a-type\n';
    const r1 = await ctx.http().post('/api/sops/bulk/import').set(as(a, 'EDITOR')).send({ csv: bad }).expect(200);
    expect(r1.body.imported).toBe(0);
    expect(r1.body.errors.map((e: { row: number }) => e.row)).toEqual([3, 4]);
    expect(await ctx.prisma.sop.count({ where: { organizationId: a.organizationId, name: 'OK-1' } })).toBe(0);
  });

  it('valid import creates every row (auto- and explicit reference numbers, folder lookup) and is a draft ready to edit', async () => {
    const folder = await ctx.http().post('/api/folders').set(as(a, 'EDITOR')).send({ name: 'Import target' }).expect(201);
    const csv = [
      'name,reference_no,type,folder',
      'Clean the line,,standard,Import target',
      'Advanced proc,IMP-REF-1,advanced,',
    ].join('\n');
    const dry = await ctx.http().post('/api/sops/bulk/import').set(as(a, 'EDITOR')).send({ csv, dryRun: true }).expect(200);
    expect(dry.body).toMatchObject({ imported: 0, valid: 2, errors: [] });
    expect(await ctx.prisma.sop.count({ where: { organizationId: a.organizationId, name: 'Clean the line' } })).toBe(0);

    const r = await ctx.http().post('/api/sops/bulk/import').set(as(a, 'EDITOR')).send({ csv }).expect(200);
    expect(r.body.imported).toBe(2);
    const inFolder = await ctx.prisma.sop.findFirstOrThrow({ where: { organizationId: a.organizationId, name: 'Clean the line' } });
    expect(inFolder.folderId).toBe(folder.body.id);
    const advanced = await ctx.prisma.sop.findFirstOrThrow({ where: { organizationId: a.organizationId, referenceNo: 'IMP-REF-1' } });
    expect(advanced.type).toBe('advanced');

    await ctx.http().post('/api/sops/bulk/import').set(as(a, 'OPERATOR')).send({ csv: 'name\nNope\n' }).expect(403);
  });

  it('rejects a reference number that already exists or repeats within the file', async () => {
    const { body } = await createSop(a, 'Existing');
    const existingRef = (await ctx.prisma.sop.findUniqueOrThrow({ where: { id: body.id } })).referenceNo;
    const dupeInFile = `name,reference_no\nA,SAME-1\nB,SAME-1\n`;
    const r1 = await ctx.http().post('/api/sops/bulk/import').set(as(a, 'EDITOR')).send({ csv: dupeInFile }).expect(200);
    expect(r1.body.errors).toHaveLength(2); // both rows sharing the duplicated reference are reported
    const clash = `name,reference_no\nC,${existingRef}\n`;
    const r2 = await ctx.http().post('/api/sops/bulk/import').set(as(a, 'EDITOR')).send({ csv: clash }).expect(200);
    expect(r2.body.errors).toHaveLength(1);
  });

  it('export CSV round-trips headers and neutralises formula injection', async () => {
    await createSop(a, '=HYPERLINK("x")');
    const r = await ctx.http().get('/api/sops/export.csv').set(as(a, 'OPERATOR')).expect(200);
    expect(r.text.split('\r\n')[0]).toBe('reference_no,name,type,status,folder,created_by,created_at,updated_at');
    expect(r.text).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe('list: sort, filters and creator facets', () => {
  it('sort options order by the expected field', async () => {
    await createSop(a, 'Zebra sort test');
    await createSop(a, 'Alpha sort test');
    const alpha = await ctx.http().get('/api/sops?search=sort test&sort=alphabetical').set(as(a, 'OPERATOR')).expect(200);
    const names = alpha.body.items.map((i: { name: string }) => i.name);
    expect(names.indexOf('Alpha sort test')).toBeLessThan(names.indexOf('Zebra sort test'));

    const newest = await ctx.http().get('/api/sops?search=sort test&sort=newest').set(as(a, 'OPERATOR')).expect(200);
    expect(newest.body.items[0].name).toBe('Alpha sort test'); // created after Zebra

    const oldest = await ctx.http().get('/api/sops?search=sort test&sort=oldest').set(as(a, 'OPERATOR')).expect(200);
    expect(oldest.body.items[0].name).toBe('Zebra sort test');
  });

  it('filters by type and by creator, and returns a stable creator facet list', async () => {
    const adv = await ctx.http().post('/api/sops').set(as(a, 'EDITOR')).send({ name: 'Adv filter test', type: 'advanced' }).expect(201);
    await ctx.http().post('/api/sops').set(a.reviewer.auth).send({ name: 'Reviewer std filter test' }).expect(201);

    const typeFiltered = await ctx.http().get('/api/sops?search=filter test&type=advanced').set(as(a, 'OPERATOR')).expect(200);
    expect(typeFiltered.body.items.map((i: { id: string }) => i.id)).toEqual([adv.body.id]);

    const reviewerId = a.reviewer.user.id;
    const byCreator = await ctx.http().get(`/api/sops?search=filter test&createdBy=${reviewerId}`).set(as(a, 'OPERATOR')).expect(200);
    expect(byCreator.body.items.length).toBeGreaterThan(0);
    expect(byCreator.body.items.every((i: { createdBy: { id: string } }) => i.createdBy.id === reviewerId)).toBe(true);
    expect(byCreator.body.facets.creators.some((c: { id: string }) => c.id === reviewerId)).toBe(true);

    // reviewer only has standard SOPs here — a type=advanced filter excludes all of them, but the
    // facet roster (independent of the current filters) still lists reviewer as a creator.
    const narrowed = await ctx.http().get('/api/sops?search=filter test&type=advanced').set(as(a, 'OPERATOR')).expect(200);
    expect(narrowed.body.items.some((i: { createdBy: { id: string } }) => i.createdBy.id === reviewerId)).toBe(false);
    expect(narrowed.body.facets.creators.some((c: { id: string }) => c.id === reviewerId)).toBe(true);
  });

  it('checklistOnly matches SOPs whose draft or published config has checklist_sop enabled', async () => {
    const { sopId, versionId } = await createSop(a, 'Checklist filter test');
    const none = await ctx.http().get('/api/sops?search=checklist filter test&checklistOnly=true').set(as(a, 'OPERATOR')).expect(200);
    expect(none.body.items).toHaveLength(0);

    await ctx.http().patch(`/api/sops/${sopId}/versions/${versionId}`).set(as(a, 'EDITOR')).send({ config: { checklist_sop: true } }).expect(200);
    const some = await ctx.http().get('/api/sops?search=checklist filter test&checklistOnly=true').set(as(a, 'OPERATOR')).expect(200);
    expect(some.body.items.map((i: { id: string }) => i.id)).toEqual([sopId]);
  });
});

describe('bulk edit (folder move / archive)', () => {
  it('moves a selection to a folder and is role-gated', async () => {
    const s1 = await createSop(a, 'Bulk edit 1');
    const s2 = await createSop(a, 'Bulk edit 2');
    const folder = await ctx.http().post('/api/folders').set(as(a, 'EDITOR')).send({ name: 'Bulk target' }).expect(201);

    await ctx.http().patch('/api/sops/bulk').set(as(a, 'OPERATOR')).send({ ids: [s1.sopId], patch: { folderId: folder.body.id } }).expect(403);

    const r = await ctx.http().patch('/api/sops/bulk').set(as(a, 'EDITOR')).send({ ids: [s1.sopId, s2.sopId], patch: { folderId: folder.body.id } }).expect(200);
    expect(r.body.updated).toBe(2);
    expect((await ctx.prisma.sop.findUniqueOrThrow({ where: { id: s1.sopId } })).folderId).toBe(folder.body.id);
    expect((await ctx.prisma.sop.findUniqueOrThrow({ where: { id: s2.sopId } })).folderId).toBe(folder.body.id);
  });

  it('bulk archives and unarchives, recomputing status', async () => {
    const { sopId } = await publishedSop(a, 'Bulk archive test');
    const r = await ctx.http().patch('/api/sops/bulk').set(as(a, 'APPROVER')).send({ ids: [sopId], patch: { archived: true } }).expect(200);
    expect(r.body.updated).toBe(1);
    expect((await ctx.prisma.sop.findUniqueOrThrow({ where: { id: sopId } })).status).toBe('archived');

    await ctx.http().patch('/api/sops/bulk').set(as(a, 'APPROVER')).send({ ids: [sopId], patch: { archived: false } }).expect(200);
    expect((await ctx.prisma.sop.findUniqueOrThrow({ where: { id: sopId } })).status).toBe('published');
  });

  it('rejects an empty patch and 404s when any id is missing or cross-tenant', async () => {
    const { sopId } = await createSop(a, 'Bulk empty patch test');
    await ctx.http().patch('/api/sops/bulk').set(as(a, 'EDITOR')).send({ ids: [sopId], patch: {} }).expect(400);

    const bSop = await createSop(b, 'Tenant B bulk target');
    await expectCrossTenantNotFound(() =>
      ctx.http().patch('/api/sops/bulk').set(as(b, 'OWNER')).send({ ids: [bSop.sopId, sopId], patch: { archived: true } }),
    );
  });
});

describe('cross-tenant isolation — SOP endpoints (§8 Phase 1 / 1.5)', () => {
  it('tenant B gets 404 on every read and write of tenant A’s SOP, versions, steps and approvals', async () => {
    const { sopId, versionId } = await publishedSop(a, 'Secret');
    const { sopId: draftSop, versionId: draftV } = await createSop(a, 'Secret draft');
    await saveSteps(a, draftSop, draftV, [{ description: 'x' }]);
    const B = as(b, 'OWNER');
    const calls = [
      () => ctx.http().get(`/api/sops/${sopId}`).set(B),
      () => ctx.http().patch(`/api/sops/${sopId}`).set(B).send({ name: 'pwned' }),
      () => ctx.http().post(`/api/sops/${sopId}/archive`).set(B).send({ archived: true }),
      () => ctx.http().get(`/api/sops/${sopId}/current`).set(B),
      () => ctx.http().get(`/api/sops/${sopId}/versions/${versionId}`).set(B),
      () => ctx.http().get(`/api/sops/${sopId}/versions/${versionId}/print`).set(B),
      () => ctx.http().get(`/api/sops/${sopId}/versions/${versionId}/approvals`).set(B),
      () => ctx.http().post(`/api/sops/${sopId}/versions`).set(B),
      () => ctx.http().patch(`/api/sops/${draftSop}/versions/${draftV}`).set(B).send({ changeSummary: 'x' }),
      () => ctx.http().put(`/api/sops/${draftSop}/versions/${draftV}/steps`).set(B).send({ steps: [] }),
      () => ctx.http().post(`/api/sops/${draftSop}/versions/${draftV}/submit`).set(B).send({}),
      () => ctx.http().post(`/api/sops/${draftSop}/versions/${draftV}/decisions`).set(B).send({ decision: 'approved' }),
      () => ctx.http().post(`/api/sops/${draftSop}/versions/${draftV}/publish`).set(B),
      () => ctx.http().post(`/api/sops/${draftSop}/versions/${draftV}/abandon`).set(B),
      // mixing a B SOP id with A's version id must not work either
    ];
    for (const call of calls) await expectCrossTenantNotFound(call);

    const bSop = await createSop(b, 'B own');
    await expectCrossTenantNotFound(() => ctx.http().get(`/api/sops/${bSop.sopId}/versions/${versionId}`).set(B));
    await expectCrossTenantNotFound(() => ctx.http().put(`/api/sops/${bSop.sopId}/versions/${draftV}/steps`).set(B).send({ steps: [] }));

    const list = await ctx.http().get('/api/sops?limit=200').set(B).expect(200);
    expect(list.body.items.map((i: { id: string }) => i.id)).not.toContain(sopId);
    const untouched = await ctx.prisma.sop.findUniqueOrThrow({ where: { id: sopId } });
    expect(untouched.name).toBe('Secret');
    expect((await ctx.prisma.sopStep.findFirstOrThrow({ where: { sopVersionId: draftV } })).description).toBe('x');

    const exp = await ctx.http().get('/api/sops/export.csv').set(B).expect(200);
    expect(exp.text).not.toContain('Secret');
    const folder = await ctx.http().post('/api/folders').set(as(a, 'EDITOR')).send({ name: 'A-only folder' }).expect(201);
    const imp = await ctx.http().post('/api/sops/bulk/import').set(B).send({ csv: `name,folder\nx,${folder.body.name}\n` }).expect(200);
    expect(imp.body.errors).toHaveLength(1); // B cannot see A's folder
  });
});
