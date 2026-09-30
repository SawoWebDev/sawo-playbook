/**
 * Phase 10 — deletion/archive policy exercised end-to-end (§7.7, §13), including
 * the org-deletion compliance carve-out and MediaAsset cleanup (§6.6).
 */
import { MaintenanceService, retention } from '../src/jobs/maintenance.service';
import { StorageService } from '../src/storage/storage.service';
import { createTenant, createTestApp, resetDatabase, Tenant, TEST_PASSWORD, TestContext } from './harness';
import { PNG_1PX, sopHelpers } from './sop-helpers';

let ctx: TestContext;
let jobs: MaintenanceService;
let storage: StorageService;
const h = sopHelpers(() => ctx);
const as = h.as;
const DAY = 86_400_000;

beforeAll(async () => {
  ctx = await createTestApp();
  jobs = ctx.app.get(MaintenanceService);
  storage = ctx.app.get(StorageService);
  await resetDatabase(ctx.prisma);
});
afterAll(() => ctx.close());

const upload = async (t: Tenant) =>
  (await ctx.http().post('/api/media').set(as(t, 'EDITOR')).attach('file', PNG_1PX, { filename: 'x.png', contentType: 'image/png' }).expect(201)).body.id as string;

describe('organization deletion lifecycle (§7.7)', () => {
  it('cooldown → soft delete → tenant purge (audit retained) → compliance purge; other tenants untouched', async () => {
    const doomed = await createTenant(ctx, 'doomed');
    const survivor = await createTenant(ctx, 'survivor');
    const { sopId } = await h.publishedSop(doomed, { name: 'Doomed SOP' });
    const mediaId = await upload(doomed);
    const key = (await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } })).storageKey;
    await h.publishedSop(survivor, { name: 'Survivor SOP' });

    const org = await ctx.prisma.organization.findUniqueOrThrow({ where: { id: doomed.organizationId } });
    await ctx.http().post('/api/organization/deletion').set(as(doomed, 'OWNER')).send({ confirmName: org.name, password: TEST_PASSWORD }).expect(201);
    const scheduled = (await ctx.prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).deletionScheduledFor!;

    // Before the cooldown ends nothing happens
    expect(await jobs.finalizeOrgDeletions(new Date(scheduled.getTime() - 1000))).toBe(0);

    // Cooldown elapsed → soft delete
    expect(await jobs.finalizeOrgDeletions(new Date(scheduled.getTime() + 1000))).toBe(1);
    const deleted = await ctx.prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(deleted.status).toBe('deleted');
    expect((await ctx.prisma.sop.findUniqueOrThrow({ where: { id: sopId } })).deletedAt).not.toBeNull();
    await ctx.http().get('/api/auth/me').set(as(doomed, 'OWNER')).expect(401);
    await ctx.http().post('/api/auth/login').send({ email: doomed.users.OWNER.user.email, password: TEST_PASSWORD }).expect(401);
    expect(await ctx.prisma.auditLog.count({ where: { organizationId: org.id, action: 'org.deletion.confirmed' } })).toBe(1);

    // Before tenant retention elapses: data still present
    expect(await jobs.purgeDeletedOrgs(new Date(scheduled.getTime() + (retention.tenantPurgeDays - 1) * DAY))).toBe(0);
    expect(await ctx.prisma.sop.count({ where: { organizationId: org.id } })).toBe(1);

    // Tenant retention elapsed → purge everything except compliance records
    const auditBefore = await ctx.prisma.auditLog.count({ where: { organizationId: org.id } });
    expect(await jobs.purgeDeletedOrgs(new Date(scheduled.getTime() + (retention.tenantPurgeDays + 1) * DAY))).toBe(1);
    for (const n of await Promise.all([
      ctx.prisma.sop.count({ where: { organizationId: org.id } }),
      ctx.prisma.sopVersion.count({ where: { organizationId: org.id } }),
      ctx.prisma.sopStep.count({ where: { organizationId: org.id } }),
      ctx.prisma.sopVersionApproval.count({ where: { organizationId: org.id } }),
      ctx.prisma.mediaAsset.count({ where: { organizationId: org.id } }),
      ctx.prisma.user.count({ where: { organizationId: org.id } }),
      ctx.prisma.activityEvent.count({ where: { organizationId: org.id } }),
    ])) {
      expect(n).toBe(0);
    }
    expect(await ctx.prisma.auditLog.count({ where: { organizationId: org.id } })).toBe(auditBefore);
    expect(await ctx.prisma.organization.findUnique({ where: { id: org.id } })).not.toBeNull();
    await expect(storage.get(key)).rejects.toBeTruthy();

    // Idempotent: a second run does nothing
    expect(await jobs.purgeDeletedOrgs(new Date(scheduled.getTime() + (retention.tenantPurgeDays + 2) * DAY))).toBe(0);

    // Compliance window elapsed → audit records + tombstone removed
    expect(await jobs.purgeExpiredCompliance(new Date(scheduled.getTime() + (retention.tenantPurgeDays + 2) * DAY))).toBe(0);
    expect(await jobs.purgeExpiredCompliance(new Date(scheduled.getTime() + (retention.auditDays + 1) * DAY))).toBe(1);
    expect(await ctx.prisma.auditLog.count({ where: { organizationId: org.id } })).toBe(0);
    expect(await ctx.prisma.organization.findUnique({ where: { id: org.id } })).toBeNull();

    // The other tenant is untouched throughout
    expect(await ctx.prisma.sop.count({ where: { organizationId: survivor.organizationId, deletedAt: null } })).toBe(1);
    await ctx.http().get('/api/auth/me').set(as(survivor, 'OWNER')).expect(200);
  }, 60_000);

  it('a cancelled deletion is never finalised', async () => {
    const t = await createTenant(ctx, 'cancel');
    const org = await ctx.prisma.organization.findUniqueOrThrow({ where: { id: t.organizationId } });
    await ctx.http().post('/api/organization/deletion').set(as(t, 'OWNER')).send({ confirmName: org.name, password: TEST_PASSWORD }).expect(201);
    await ctx.http().delete('/api/organization/deletion').set(as(t, 'OWNER')).expect(200);
    await jobs.finalizeOrgDeletions(new Date(Date.now() + 30 * DAY));
    expect((await ctx.prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).status).toBe('active');
  });
});

describe('media cleanup (§6.6, Invariant #12)', () => {
  it('orphaned → soft_deleted after grace → purged (object removed); referenced media is never touched', async () => {
    const t = await createTenant(ctx, 'media');
    const { sopId, versionId } = await h.createSop(t, 'Media SOP');
    const kept = await upload(t);
    const dropped = await upload(t);
    await h.saveSteps(t, sopId, versionId, [{ description: 'x', media: [{ mediaAssetId: kept }, { mediaAssetId: dropped }] }]);
    await h.saveSteps(t, sopId, versionId, [{ description: 'x', media: [{ mediaAssetId: kept }] }]);
    await h.publishFlow(t, sopId, versionId);
    const droppedKey = (await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: dropped } })).storageKey;
    expect((await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: dropped } })).lifecycleState).toBe('orphaned');

    // within grace: nothing
    let r = await jobs.cleanupMedia(new Date(Date.now() + (retention.mediaOrphanGraceDays - 1) * DAY));
    expect((await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: dropped } })).lifecycleState).toBe('orphaned');

    // after grace: soft_deleted
    r = await jobs.cleanupMedia(new Date(Date.now() + (retention.mediaOrphanGraceDays + 1) * DAY));
    expect(r.softDeleted).toBeGreaterThanOrEqual(1);
    const soft = await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: dropped } });
    expect(soft.lifecycleState).toBe('soft_deleted');

    // a soft-deleted asset may not be re-used
    const d2 = await ctx.http().post(`/api/sops/${sopId}/versions`).set(as(t, 'EDITOR')).expect(201);
    await ctx.http().put(`/api/sops/${sopId}/versions/${d2.body.id}/steps`).set(as(t, 'EDITOR')).send({ steps: [{ description: 'x', media: [{ mediaAssetId: dropped }] }] }).expect(400);

    // after soft-delete retention: purged + object gone
    r = await jobs.cleanupMedia(new Date(soft.deletedAt!.getTime() + (retention.mediaSoftDeleteDays + 1) * DAY));
    expect(r.purged).toBeGreaterThanOrEqual(1);
    expect((await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: dropped } })).lifecycleState).toBe('purged');
    await expect(storage.get(droppedKey)).rejects.toBeTruthy();

    // media referenced by the published version stays referenced and its object remains
    const k = await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: kept } });
    expect(k.lifecycleState).toBe('referenced');
    await expect(storage.get(k.storageKey)).resolves.toBeInstanceOf(Buffer);
  }, 60_000);

  it('an orphan re-attached before the grace period ends is not soft-deleted', async () => {
    const t = await createTenant(ctx, 'reattach');
    const { sopId, versionId } = await h.createSop(t, 'Reattach');
    const m = await upload(t);
    await h.saveSteps(t, sopId, versionId, [{ description: 'x', media: [{ mediaAssetId: m }] }]);
    await h.saveSteps(t, sopId, versionId, [{ description: 'x' }]);
    await h.saveSteps(t, sopId, versionId, [{ description: 'x', media: [{ mediaAssetId: m }] }]);
    await jobs.cleanupMedia(new Date(Date.now() + 365 * DAY));
    expect((await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: m } })).lifecycleState).toBe('attached');
  });
});
