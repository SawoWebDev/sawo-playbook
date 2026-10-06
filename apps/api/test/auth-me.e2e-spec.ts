/** GET /auth/me exposes the caller's effective permissions and group IDs. The guard remains the enforcement point. */
import { createTenant, createTestApp, resetDatabase, Tenant, TestContext } from './harness';

let ctx: TestContext;
let t: Tenant;

beforeAll(async () => {
  ctx = await createTestApp();
  await resetDatabase(ctx.prisma);
  t = await createTenant(ctx, 'auth-me');
});
afterAll(() => ctx.close());

const me = (auth: { Authorization: string }) => ctx.http().get('/api/auth/me').set(auth).expect(200);

describe('GET /api/auth/me', () => {
  it('keeps the existing identity fields', async () => {
    const r = await me(t.users.EDITOR.auth);
    expect(r.body).toMatchObject({ id: t.users.EDITOR.user.id, organizationId: t.organizationId, role: 'EDITOR', email: t.users.EDITOR.user.email, name: expect.any(String) });
  });

  it('Admin holds every permission, including admin-only ones, and never the internal "authenticated" marker', async () => {
    const r = await me(t.users.ADMIN.auth);
    expect(r.body.permissions).toEqual(expect.arrayContaining(['users.manage', 'roles.manage', 'groups.manage', 'organization.delete', 'kanban.publish', 'sop.publish']));
    expect(r.body.permissions).not.toContain('authenticated');
    expect(r.body.groupIds).toEqual([]);
  });

  it('Viewer is read-only: can view, cannot create, edit, submit, approve or publish', async () => {
    const p: string[] = (await me(t.users.OPERATOR.auth)).body.permissions;
    expect(p).toEqual(expect.arrayContaining(['kanban.view', 'sop.view']));
    for (const denied of ['kanban.create', 'kanban.edit', 'sop.create', 'sop.edit', 'sop.submit', 'kanban.publish', 'sop.publish', 'users.manage']) {
      expect(p).not.toContain(denied);
    }
  });

  it('Editor can create, edit and submit, but cannot publish, approve or pre-approve', async () => {
    const p: string[] = (await me(t.users.EDITOR.auth)).body.permissions;
    expect(p).toEqual(expect.arrayContaining(['kanban.create', 'kanban.edit', 'kanban.submit', 'sop.create', 'sop.edit', 'sop.submit']));
    for (const denied of ['kanban.publish', 'sop.publish', 'kanban.approve', 'sop.approve', 'kanban.preapprove', 'sop.preapprove', 'kanban.bulk']) {
      expect(p).not.toContain(denied);
    }
  });

  it('Pre Approver can review and pre-approve, but cannot publish or give final approval', async () => {
    const p: string[] = (await me(t.users.PRE_APPROVER.auth)).body.permissions;
    expect(p).toEqual(expect.arrayContaining(['kanban.review', 'kanban.preapprove', 'sop.review', 'sop.preapprove']));
    for (const denied of ['kanban.publish', 'sop.publish', 'kanban.approve', 'sop.approve', 'sop.edit', 'kanban.edit']) {
      expect(p).not.toContain(denied);
    }
  });

  it('Approver can approve and publish (including direct publish), but cannot pre-approve or manage users', async () => {
    const p: string[] = (await me(t.users.APPROVER.auth)).body.permissions;
    expect(p).toEqual(expect.arrayContaining(['kanban.approve', 'kanban.publish', 'kanban.bulk', 'sop.approve', 'sop.publish']));
    for (const denied of ['kanban.preapprove', 'sop.preapprove', 'users.manage', 'roles.manage', 'folders.edit', 'skills.update', 'analytics.view']) {
      expect(p).not.toContain(denied);
    }
  });

  it('group IDs are the caller\'s current memberships: the General group for non-Admins', async () => {
    const general = await ctx.prisma.userGroup.findFirstOrThrow({ where: { organizationId: t.organizationId, name: 'General' } });
    expect((await me(t.users.EDITOR.auth)).body.groupIds).toEqual([general.id]);
    expect((await me(t.users.APPROVER.auth)).body.groupIds).toEqual([general.id]);
  });

  it('a permission change by an Admin shows in the affected user\'s next /me, and the guard still enforces it', async () => {
    const before: string[] = (await me(t.users.EDITOR.auth)).body.permissions;
    expect(before).toContain('kanban.create');
    const editorRow = (await ctx.http().get('/api/roles').set(t.users.ADMIN.auth).expect(200)).body.roles.find((r: { role: string }) => r.role === 'EDITOR');
    await ctx.http().put('/api/roles/EDITOR').set(t.users.ADMIN.auth).send({ permissions: editorRow.permissions.filter((p: string) => p !== 'kanban.create') }).expect(200);
    const after: string[] = (await me(t.users.EDITOR.auth)).body.permissions;
    expect(after).not.toContain('kanban.create');
    // the display list and the enforcement agree
    const draft = await ctx.http().post('/api/kanbans').set(t.users.EDITOR.auth).send({ partCode: 'ME-1', orderingType: 'email', orderingEmail: 'x@y.co' }).expect(403);
    expect(draft.status).toBe(403);
    await ctx.http().delete('/api/roles/EDITOR').set(t.users.ADMIN.auth).expect(200);
  });

  it('an unauthenticated request is still refused', async () => {
    await ctx.http().get('/api/auth/me').expect(401);
  });
});
