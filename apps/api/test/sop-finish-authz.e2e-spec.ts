/**
 * Regression: POST /sops/:id/versions/:vid/finish publishes directly when approval_required = false.
 * It must require sop.publish, not sop.edit, so an Editor cannot bypass the approval model.
 */
import { createTenant, createTestApp, resetDatabase, Tenant, TestContext } from './harness';
import { sopHelpers } from './sop-helpers';

let ctx: TestContext;
let t: Tenant;
const h = sopHelpers(() => ctx);
const as = h.as;
const STEPS = [{ description: 'Check the seal' }];

beforeAll(async () => {
  ctx = await createTestApp();
  await resetDatabase(ctx.prisma);
  t = await createTenant(ctx, 'finish-authz');
  // The bug only shows when approval is not required, so make that explicit rather than relying on the default.
  await ctx.prisma.organizationSettings.update({ where: { organizationId: t.organizationId }, data: { approvalRequired: false } });
});
afterAll(() => ctx.close());

/** A fresh editable draft with one step, so finish has something to publish. */
async function editableDraft(name: string) {
  const { sopId, versionId } = await h.createSop(t, name);
  await h.saveSteps(t, sopId, versionId, STEPS);
  return { sopId, versionId };
}

/** Everything that would change if a publish happened. Compared before and after the attempt. */
async function publishState(sopId: string, versionId: string) {
  const version = await ctx.prisma.sopVersion.findUniqueOrThrow({ where: { id: versionId } });
  const sop = await ctx.prisma.sop.findUniqueOrThrow({ where: { id: sopId } });
  const [audit, activity] = await Promise.all([
    ctx.prisma.auditLog.count({ where: { organizationId: t.organizationId, entityId: versionId, action: 'sop.version.published' } }),
    ctx.prisma.activityEvent.count({ where: { organizationId: t.organizationId, entityId: sopId, eventType: 'sop.version.published' } }),
  ]);
  return { lifecycleState: version.lifecycleState, publishedById: version.publishedById, sopStatus: sop.status, currentPublishedVersionId: sop.currentPublishedVersionId, audit, activity };
}

describe('finish publishes only with sop.publish (approval_required = false)', () => {
  it('an Editor gets 403 from finish; the version is not published, and no publish audit or activity is written', async () => {
    const { sopId, versionId } = await editableDraft('Editor bypass attempt');
    const before = await publishState(sopId, versionId);
    expect(before).toMatchObject({ lifecycleState: 'DRAFT', currentPublishedVersionId: null });

    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/finish`).set(as(t, 'EDITOR')).send({}).expect(403);

    expect(await publishState(sopId, versionId)).toEqual(before);
  });

  it('a Viewer and a Pre Approver are refused by finish too', async () => {
    const { sopId, versionId } = await editableDraft('Other roles attempt');
    const before = await publishState(sopId, versionId);
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/finish`).set(as(t, 'OPERATOR')).send({}).expect(403);
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/finish`).set(as(t, 'PRE_APPROVER')).send({}).expect(403);
    expect(await publishState(sopId, versionId)).toEqual(before);
  });

  it('an authorised publisher (Approver) can still complete the equivalent direct publish', async () => {
    const { sopId, versionId } = await editableDraft('Approver direct publish');
    const res = await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/finish`).set(as(t, 'APPROVER')).send({}).expect(200);
    expect(res.body).toBeTruthy();
    const after = await publishState(sopId, versionId);
    expect(after).toMatchObject({ lifecycleState: 'PUBLISHED', sopStatus: 'published', currentPublishedVersionId: versionId, audit: 1, activity: 1 });
    expect(after.publishedById).toBe(t.users.APPROVER.user.id);
  });

  it('an Admin is unrestricted and can finish', async () => {
    const { sopId, versionId } = await editableDraft('Admin direct publish');
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/finish`).set(as(t, 'ADMIN')).send({}).expect(200);
    expect((await publishState(sopId, versionId)).lifecycleState).toBe('PUBLISHED');
  });

  it('with approval_required = true, finish is still refused (existing behaviour preserved), even for an Approver', async () => {
    await ctx.prisma.organizationSettings.update({ where: { organizationId: t.organizationId }, data: { approvalRequired: true } });
    try {
      const { sopId, versionId } = await editableDraft('Approval required');
      const before = await publishState(sopId, versionId);
      await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/finish`).set(as(t, 'APPROVER')).send({}).expect(403);
      expect(await publishState(sopId, versionId)).toEqual(before);
    } finally {
      await ctx.prisma.organizationSettings.update({ where: { organizationId: t.organizationId }, data: { approvalRequired: false } });
    }
  });
});
