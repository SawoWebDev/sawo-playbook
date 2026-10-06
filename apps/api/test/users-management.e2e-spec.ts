/** User management: list with groups, user detail with approval readiness, profile edits, isolation, and the Admin rule. */
import { createTenant, createTestApp, resetDatabase, Tenant, TestContext } from './harness';

let ctx: TestContext;
let a: Tenant;
let b: Tenant;

beforeAll(async () => {
  ctx = await createTestApp();
  await resetDatabase(ctx.prisma);
  a = await createTenant(ctx, 'users-a');
  b = await createTenant(ctx, 'users-b');
});
afterAll(() => ctx.close());

describe('listing and detail', () => {
  it('GET /users includes approvalReadiness for every user, identical to GET /users/:id (one helper, one answer)', async () => {
    const pending = await a.addUser('APPROVER', 'list-readiness');
    await ctx.prisma.user.update({ where: { id: pending.user.id }, data: { status: 'suspended' } });
    const list = await ctx.http().get('/api/users').set(a.users.ADMIN.auth).expect(200);
    expect(list.body.length).toBeGreaterThan(0);
    for (const row of list.body) {
      expect(Object.keys(row.approvalReadiness).sort()).toEqual(['issue', 'ready']);
      expect(typeof row.approvalReadiness.ready).toBe('boolean');
      expect(row.approvalReadiness.issue === null || typeof row.approvalReadiness.issue === 'string').toBe(true);
      const detail = await ctx.http().get(`/api/users/${row.id}`).set(a.users.ADMIN.auth).expect(200);
      expect(row.approvalReadiness).toEqual(detail.body.approvalReadiness);
    }
    const suspendedRow = list.body.find((u: { id: string }) => u.id === pending.user.id);
    expect(suspendedRow.approvalReadiness).toEqual({ ready: false, issue: 'Account is not active' });
    // existing fields are preserved
    expect(list.body[0]).toMatchObject({ id: expect.any(String), email: expect.any(String), orgRole: expect.any(String), groups: expect.any(Array) });
  });

  it('the user list shows each user with their groups, and the Admin can see it', async () => {
    const list = await ctx.http().get('/api/users').set(a.users.ADMIN.auth).expect(200);
    const editor = list.body.find((u: { id: string }) => u.id === a.users.EDITOR.user.id);
    expect(editor.groups).toEqual([{ id: expect.any(String), name: 'General' }]);
    const admin = list.body.find((u: { id: string }) => u.id === a.users.ADMIN.user.id);
    expect(admin.groups).toEqual([]);
  });

  it('user detail returns role, status, groups and approval readiness', async () => {
    const d = await ctx.http().get(`/api/users/${a.users.EDITOR.user.id}`).set(a.users.ADMIN.auth).expect(200);
    expect(d.body).toMatchObject({ orgRole: 'EDITOR', status: 'active', approvalReadiness: { ready: true, issue: null } });
    expect(d.body.groups.map((g: { name: string }) => g.name)).toEqual(['General']);
  });

  it('a Pre Approver or Approver is flagged as not ready when the account is not active', async () => {
    const approver = await a.addUser('APPROVER', 'not-ready');
    await ctx.prisma.user.update({ where: { id: approver.user.id }, data: { status: 'suspended' } });
    const d = await ctx.http().get(`/api/users/${approver.user.id}`).set(a.users.ADMIN.auth).expect(200);
    expect(d.body.approvalReadiness).toEqual({ ready: false, issue: 'Account is not active' });
  });

  it('another organisation cannot see the user, and a non-Admin cannot manage users', async () => {
    await ctx.http().get(`/api/users/${a.users.EDITOR.user.id}`).set(b.users.ADMIN.auth).expect(404);
    await ctx.http().get(`/api/users/${a.users.EDITOR.user.id}`).set(a.users.EDITOR.auth).expect(403);
    await ctx.http().patch(`/api/users/${a.users.EDITOR.user.id}`).set(a.users.APPROVER.auth).send({ name: 'x' }).expect(403);
  });
});

describe('profile edits', () => {
  it('name changes; email must be unique within the platform', async () => {
    const u = await a.addUser('OPERATOR', 'rename');
    const r = await ctx.http().patch(`/api/users/${u.user.id}`).set(a.users.ADMIN.auth).send({ name: '  New Name  ' }).expect(200);
    expect(r.body.name).toBe('New Name');
    await ctx.http().patch(`/api/users/${u.user.id}`).set(a.users.ADMIN.auth).send({ email: b.users.EDITOR.user.email }).expect(409);
  });

  it('changing the email revokes the user\'s existing sessions, because the address is their login', async () => {
    const u = await a.addUser('EDITOR', 'email-change');
    await ctx.http().get('/api/auth/me').set(u.auth).expect(200);
    await ctx.http().patch(`/api/users/${u.user.id}`).set(a.users.ADMIN.auth).send({ email: `moved-${Date.now()}@users-a.test` }).expect(200);
    await ctx.http().get('/api/auth/me').set(u.auth).expect(401);
  });

  it('an Admin cannot edit another Admin; the change is audited', async () => {
    const other = await a.addUser('ADMIN', 'peer-admin');
    await ctx.http().patch(`/api/users/${other.user.id}`).set(a.users.ADMIN.auth).send({ name: 'x' }).expect(403);
    const u = await a.addUser('OPERATOR', 'audited');
    await ctx.http().patch(`/api/users/${u.user.id}`).set(a.users.ADMIN.auth).send({ name: 'Audited Name' }).expect(200);
    const row = await ctx.prisma.auditLog.findFirstOrThrow({ where: { organizationId: a.organizationId, action: 'user.updated', entityId: u.user.id } });
    expect(row.metadata).toMatchObject({ fields: ['name'], emailChanged: false });
  });

  it('invalid profile input is refused', async () => {
    const u = await a.addUser('OPERATOR', 'invalid');
    await ctx.http().patch(`/api/users/${u.user.id}`).set(a.users.ADMIN.auth).send({ email: 'not-an-email' }).expect(400);
    await ctx.http().patch(`/api/users/${u.user.id}`).set(a.users.ADMIN.auth).send({ role: 'OWNER' }).expect(400);
  });
});
