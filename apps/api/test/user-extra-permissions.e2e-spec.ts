/** Per-person extra permissions: granted on top of the role, Admin-only, Admin-protected, audited, and effective at once. */
import { createTenant, createTestApp, resetDatabase, Tenant, TestContext } from './harness';

let ctx: TestContext;
let a: Tenant;
let b: Tenant;

beforeAll(async () => {
  ctx = await createTestApp();
  await resetDatabase(ctx.prisma);
  a = await createTenant(ctx, 'extra-a');
  b = await createTenant(ctx, 'extra-b');
});
afterAll(() => ctx.close());

describe('extra permissions', () => {
  it('a Pre Approver granted kanban.edit gains it on their next request, and it is audited', async () => {
    const pa = await a.addUser('PRE_APPROVER', 'extra-grant');
    const before = await ctx.http().get('/api/auth/me').set(pa.auth).expect(200);
    expect(before.body.permissions).not.toContain('kanban.edit');

    const r = await ctx.http().patch(`/api/users/${pa.user.id}/permissions`).set(a.users.ADMIN.auth).send({ permissions: ['kanban.edit'] }).expect(200);
    expect(r.body.extraPermissions).toEqual(['kanban.edit']);

    const after = await ctx.http().get('/api/auth/me').set(pa.auth).expect(200);
    expect(after.body.permissions).toContain('kanban.edit');
    expect(after.body.role).toBe('PRE_APPROVER');

    const log = await ctx.prisma.auditLog.findFirst({ where: { entityId: pa.user.id, action: 'user.permissions.changed' } });
    expect(log).not.toBeNull();
  });

  it('removing an extra takes it away again; the role itself is unchanged', async () => {
    const pa = await a.addUser('PRE_APPROVER', 'extra-revoke');
    await ctx.http().patch(`/api/users/${pa.user.id}/permissions`).set(a.users.ADMIN.auth).send({ permissions: ['sop.edit'] }).expect(200);
    await ctx.http().patch(`/api/users/${pa.user.id}/permissions`).set(a.users.ADMIN.auth).send({ permissions: [] }).expect(200);
    const me = await ctx.http().get('/api/auth/me').set(pa.auth).expect(200);
    expect(me.body.permissions).not.toContain('sop.edit');
    expect(me.body.role).toBe('PRE_APPROVER');
  });

  it('Admin-only permissions can never be granted to a person', async () => {
    const e = await a.addUser('EDITOR', 'extra-admin-only');
    const r = await ctx.http().patch(`/api/users/${e.user.id}/permissions`).set(a.users.ADMIN.auth).send({ permissions: ['users.manage'] }).expect(400);
    expect(r.body.message).toContain('users.manage');
    const me = await ctx.http().get('/api/auth/me').set(e.auth).expect(200);
    expect(me.body.permissions).not.toContain('users.manage');
  });

  it('unknown keys are refused, and the detail screen shows the saved extras', async () => {
    const e = await a.addUser('OPERATOR', 'extra-unknown');
    await ctx.http().patch(`/api/users/${e.user.id}/permissions`).set(a.users.ADMIN.auth).send({ permissions: ['not.a.permission'] }).expect(400);
    await ctx.http().patch(`/api/users/${e.user.id}/permissions`).set(a.users.ADMIN.auth).send({ permissions: ['sop.edit'] }).expect(200);
    const d = await ctx.http().get(`/api/users/${e.user.id}`).set(a.users.ADMIN.auth).expect(200);
    expect(d.body.extraPermissions).toEqual(['sop.edit']);
  });

  it('Admins cannot be given extras (they already hold everything), and a non-Admin cannot change them', async () => {
    await ctx.http().patch(`/api/users/${a.users.ADMIN.user.id}/permissions`).set(a.users.ADMIN.auth).send({ permissions: [] }).expect(403);
    const e = await a.addUser('EDITOR', 'extra-non-admin');
    await ctx.http().patch(`/api/users/${e.user.id}/permissions`).set(a.users.APPROVER.auth).send({ permissions: ['sop.edit'] }).expect(403);
  });

  it("the user list carries each person's extra permissions, so the list can show a special-access badge", async () => {
    const e = await a.addUser("APPROVER", "extra-list");
    await ctx.http().patch(`/api/users/${e.user.id}/permissions`).set(a.users.ADMIN.auth).send({ permissions: ["sop.view"] }).expect(200);
    const list = await ctx.http().get("/api/users").set(a.users.ADMIN.auth).expect(200);
    const row = list.body.find((u: { id: string }) => u.id === e.user.id);
    expect(row.extraPermissions).toEqual(["sop.view"]);
    const plain = list.body.find((u: { id: string }) => u.id === a.users.EDITOR.user.id);
    expect(plain.extraPermissions).toEqual([]);
  });

  it('another organisation cannot change a person\'s extras', async () => {
    const e = await a.addUser('OPERATOR', 'extra-cross');
    await ctx.http().patch(`/api/users/${e.user.id}/permissions`).set(b.users.ADMIN.auth).send({ permissions: ['sop.edit'] }).expect(404);
  });
});
