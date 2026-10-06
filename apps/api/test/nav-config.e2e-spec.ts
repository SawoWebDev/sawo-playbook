/** Admin-customisable sidebar menu: who can change it, what can be hidden, and that everyone reads the same result. */
import { createTenant, createTestApp, resetDatabase, Tenant, TestContext } from './harness';

let ctx: TestContext;
let t: Tenant;
const settings = (role: 'ADMIN' | 'EDITOR' | 'OPERATOR') => ctx.http().get('/api/organization').set(t.users[role].auth).expect(200);
const patch = (body: object, role: 'ADMIN' | 'EDITOR' = 'ADMIN') => ctx.http().patch('/api/organization/settings').set(t.users[role].auth).send(body);

beforeAll(async () => {
  ctx = await createTestApp();
  await resetDatabase(ctx.prisma);
  t = await createTenant(ctx, 'nav');
});
afterAll(() => ctx.close());

describe('sidebar menu customisation', () => {
  it('starts with the built-in menu (navConfig is null)', async () => {
    expect((await settings('ADMIN')).body.settings.navConfig).toBeNull();
  });

  it('an Admin can hide Skills and reorder the rest; any signed-in user then reads it', async () => {
    const cfg = { order: ['/kanbans', '/sops', '/folders'], hidden: ['/skills'] };
    const res = await patch({ navConfig: cfg }).expect(200);
    expect(res.body.settings.navConfig).toEqual(cfg);
    expect((await settings('OPERATOR')).body.settings.navConfig).toEqual(cfg);
  });

  it('saving other settings does not touch the menu', async () => {
    await patch({ approvalQuorum: 2 }).expect(200);
    expect((await settings('ADMIN')).body.settings.navConfig).toEqual({ order: ['/kanbans', '/sops', '/folders'], hidden: ['/skills'] });
  });

  it('an Admin can switch Skills back on later', async () => {
    const res = await patch({ navConfig: { order: [], hidden: [] } }).expect(200);
    expect(res.body.settings.navConfig).toEqual({ order: [], hidden: [] });
  });

  it('only people who can manage organisation settings may change it (403)', async () => {
    await patch({ navConfig: { order: [], hidden: ['/skills'] } }, 'EDITOR').expect(403);
  });

  it('administration screens cannot be hidden or reordered, so an admin can never lock themselves out', async () => {
    for (const href of ['/settings', '/users', '/roles', '/backups', '/audit', '/nope']) {
      await patch({ navConfig: { order: [], hidden: [href] } }).expect(400);
      await patch({ navConfig: { order: [href], hidden: [] } }).expect(400);
    }
  });

  it('at least one item must stay visible', async () => {
    const all = ['/sops', '/kanbans', '/skills', '/folders', '/checklists', '/approvals', '/analytics'];
    await patch({ navConfig: { order: [], hidden: all } }).expect(400);
    await patch({ navConfig: { order: [], hidden: all.slice(1) } }).expect(200);
  });

  it('rejects a malformed menu', async () => {
    await patch({ navConfig: { order: 'x', hidden: [] } }).expect(400);
    await patch({ navConfig: { hidden: [] } }).expect(400);
  });

  it('null restores the built-in menu', async () => {
    const res = await patch({ navConfig: null }).expect(200);
    expect(res.body.settings.navConfig).toBeNull();
  });

  it('every change is written to the audit log', async () => {
    const rows = await ctx.prisma.auditLog.findMany({ where: { organizationId: t.organizationId, action: { startsWith: 'org.settings' } } });
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });
});
