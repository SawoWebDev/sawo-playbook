/** Role & permission API: defaults, Admin-only protection, overrides that take effect immediately, and reset. */
import { createTenant, createTestApp, resetDatabase, Tenant, TestContext } from './harness';
import { sopHelpers } from './sop-helpers';

let ctx: TestContext;
let t: Tenant;
const h = sopHelpers(() => ctx);

beforeAll(async () => {
  ctx = await createTestApp();
  await resetDatabase(ctx.prisma);
  t = await createTenant(ctx, 'roles');
});
afterAll(() => ctx.close());

const roleRow = async (role: string) => (await ctx.http().get('/api/roles').set(t.users.ADMIN.auth).expect(200)).body.roles.find((r: { role: string }) => r.role === role);

describe('reading the role matrix', () => {
  it('lists exactly the five roles; Admin is locked and holds everything', async () => {
    const body = (await ctx.http().get('/api/roles').set(t.users.ADMIN.auth).expect(200)).body;
    expect(body.roles.map((r: { role: string }) => r.role).sort()).toEqual(['ADMIN', 'APPROVER', 'EDITOR', 'OPERATOR', 'PRE_APPROVER']);
    const admin = body.roles.find((r: { role: string }) => r.role === 'ADMIN');
    expect(admin).toMatchObject({ locked: true, customised: false });
    expect(admin.permissions).toEqual(expect.arrayContaining(['users.manage', 'roles.manage', 'organization.delete', 'kanban.publish']));
  });

  it('defaults match the approved matrix: Approver has no folder, checklist, analytics or skills rights', async () => {
    const approver = await roleRow('APPROVER');
    for (const p of ['folders.edit', 'checklist.view_all', 'analytics.view', 'analytics.view_all', 'skills.update']) {
      expect(approver.permissions).not.toContain(p);
    }
    expect(approver.permissions).toEqual(expect.arrayContaining(['kanban.publish', 'kanban.bulk', 'kanban.approve', 'sop.publish']));
    const pre = await roleRow('PRE_APPROVER');
    expect(pre.permissions).not.toContain('kanban.publish');
    expect(pre.permissions).toEqual(expect.arrayContaining(['kanban.preapprove', 'sop.preapprove']));
  });

  it('admin-only permissions are listed separately and are never offered as configurable', async () => {
    const body = (await ctx.http().get('/api/roles').set(t.users.ADMIN.auth).expect(200)).body;
    expect(body.configurable).not.toContain('users.manage');
    expect(body.configurable).not.toContain('roles.manage');
    expect(body.adminOnly).toEqual(expect.arrayContaining(['users.manage', 'roles.manage', 'groups.manage', 'organization.delete']));
  });

  it.each(['OPERATOR', 'EDITOR', 'PRE_APPROVER', 'APPROVER'] as const)('a %s cannot read or change the matrix (403)', async (role) => {
    await ctx.http().get('/api/roles').set(t.users[role].auth).expect(403);
    await ctx.http().put(`/api/roles/${role}`).set(t.users[role].auth).send({ permissions: [] }).expect(403);
  });
});

describe('changing the matrix', () => {
  it('Admin cannot be edited; Owner and Trainer are not roles here', async () => {
    await ctx.http().put('/api/roles/ADMIN').set(t.users.ADMIN.auth).send({ permissions: [] }).expect(400);
    await ctx.http().put('/api/roles/OWNER').set(t.users.ADMIN.auth).send({ permissions: [] }).expect(400);
    await ctx.http().put('/api/roles/TRAINER').set(t.users.ADMIN.auth).send({ permissions: [] }).expect(400);
  });

  it('Admin-only permissions cannot be granted to a non-Admin role', async () => {
    const r = await ctx.http().put('/api/roles/EDITOR').set(t.users.ADMIN.auth).send({ permissions: ['kanban.view', 'users.manage', 'roles.manage'] }).expect(400);
    expect(r.body.message).toMatch(/users\.manage/);
    expect((await roleRow('EDITOR')).permissions).not.toContain('users.manage');
  });

  it('an unknown permission string is refused', async () => {
    await ctx.http().put('/api/roles/EDITOR').set(t.users.ADMIN.auth).send({ permissions: ['made.up'] }).expect(400);
  });

  it('removing a permission takes effect on the very next request, and restoring it does too', async () => {
    const publisher = await t.addUser('APPROVER', 'immediate');
    const draft = await ctx.http().post('/api/kanbans').set(publisher.auth).send({ partCode: 'IMM-1', orderingType: 'email', orderingEmail: 'x@y.co' }).expect(201);
    // Still allowed under the defaults.
    await ctx.http().get('/api/roles').set(publisher.auth).expect(403); // sanity: not an admin

    const approver = await roleRow('APPROVER');
    const without = approver.permissions.filter((p: string) => p !== 'kanban.publish');
    await ctx.http().put('/api/roles/APPROVER').set(t.users.ADMIN.auth).send({ permissions: without }).expect(200);
    await ctx.http().post(`/api/kanbans/revisions/${draft.body.id}/publish`).set(publisher.auth).expect(403);

    await ctx.http().put('/api/roles/APPROVER').set(t.users.ADMIN.auth).send({ permissions: approver.permissions }).expect(200);
    await ctx.http().post(`/api/kanbans/revisions/${draft.body.id}/publish`).set(publisher.auth).expect(200);
  });

  it('a granted permission works on the next request (override that adds publish to Editors)', async () => {
    const editor = await t.addUser('EDITOR', 'granted');
    const draft = await ctx.http().post('/api/kanbans').set(editor.auth).send({ partCode: 'GRANT-1', orderingType: 'email', orderingEmail: 'x@y.co' }).expect(201);
    await ctx.http().post(`/api/kanbans/revisions/${draft.body.id}/publish`).set(editor.auth).expect(403);
    const editorRow = await roleRow('EDITOR');
    await ctx.http().put('/api/roles/EDITOR').set(t.users.ADMIN.auth).send({ permissions: [...editorRow.permissions, 'kanban.publish'] }).expect(200);
    await ctx.http().post(`/api/kanbans/revisions/${draft.body.id}/publish`).set(editor.auth).expect(200);
    const after = await roleRow('EDITOR');
    expect(after.customised).toBe(true);
    await ctx.http().delete('/api/roles/EDITOR').set(t.users.ADMIN.auth).expect(200);
    expect((await roleRow('EDITOR')).customised).toBe(false);
  });

  it('every change is audited with before, after, added and removed', async () => {
    const rows = await ctx.prisma.auditLog.findMany({ where: { organizationId: t.organizationId, action: 'role.permissions.changed' }, orderBy: { occurredAt: 'asc' } });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const removal = rows[0].metadata as { role: string; removed: string[] };
    expect(removal.role).toBe('APPROVER');
    expect(removal.removed).toEqual(['kanban.publish']);
  });

  it('an override cannot make another organisation\'s data visible: changes apply to this organisation only', async () => {
    const other = await createTenant(ctx, 'roles-other');
    const before = await ctx.http().get('/api/roles').set(other.users.ADMIN.auth).expect(200);
    expect(before.body.roles.find((r: { role: string }) => r.role === 'APPROVER').customised).toBe(false);
  });
});

describe('SOP publish stays on the publish permission', () => {
  it('an Editor still cannot publish an SOP through the publish route', async () => {
    const { sopId, versionId } = await h.createSop(t, 'Role check');
    await h.saveSteps(t, sopId, versionId, [{ description: 'x' }]);
    await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/publish`).set(t.users.EDITOR.auth).send({}).expect(403);
  });
});
