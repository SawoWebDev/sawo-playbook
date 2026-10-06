/** SOP archive requires publish authority (not just edit), and every archive change is audited on its own. */
import { createTenant, createTestApp, resetDatabase, Tenant, TestContext } from './harness';
import { sopHelpers } from './sop-helpers';

let ctx: TestContext;
let a: Tenant;
const h = sopHelpers(() => ctx);
const as = h.as;

beforeAll(async () => {
  ctx = await createTestApp();
  await resetDatabase(ctx.prisma);
  a = await createTenant(ctx, 'archive');
});
afterAll(() => ctx.close());

describe('SOP archive gate', () => {
  it('an Editor (edit, not publish) cannot archive or unarchive; an Approver can; each is audited', async () => {
    const { sopId } = await h.publishedSop(a, { name: 'Archive me' });
    await ctx.http().post(`/api/sops/${sopId}/archive`).set(as(a, 'EDITOR')).send({ archived: true }).expect(403);
    await ctx.http().post(`/api/sops/${sopId}/archive`).set(as(a, 'APPROVER')).send({ archived: true }).expect(200);
    await ctx.http().post(`/api/sops/${sopId}/archive`).set(as(a, 'APPROVER')).send({ archived: false }).expect(200);
    const rows = await ctx.prisma.auditLog.findMany({ where: { organizationId: a.organizationId, action: 'sop.archived', entityId: sopId } });
    expect(rows.map((r) => r.metadata)).toEqual([{ archived: true, previouslyArchived: false }, { archived: false, previouslyArchived: true }]);
  });

  it('a bulk archive by an Editor is refused, but a bulk folder move by an Editor is allowed', async () => {
    const { sopId } = await h.publishedSop(a, { name: 'Bulk archive' });
    await ctx.http().patch('/api/sops/bulk').set(as(a, 'EDITOR')).send({ ids: [sopId], patch: { archived: true } }).expect(403);
    await ctx.http().patch('/api/sops/bulk').set(as(a, 'EDITOR')).send({ ids: [sopId], patch: { folderId: null } }).expect(200);
  });
});
