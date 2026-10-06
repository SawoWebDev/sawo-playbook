/** Groups API: Admin CRUD, membership, organisation isolation, role refusals, and the non-Admin group rule. */
import { createTenant, createTestApp, resetDatabase, Tenant, TestContext } from './harness';

let ctx: TestContext;
let a: Tenant;
let b: Tenant;

beforeAll(async () => {
  ctx = await createTestApp();
  await resetDatabase(ctx.prisma);
  a = await createTenant(ctx, 'groups-a');
  b = await createTenant(ctx, 'groups-b');
});
afterAll(() => ctx.close());

const generalOf = (t: Tenant) => ctx.prisma.userGroup.findFirstOrThrow({ where: { organizationId: t.organizationId, name: 'General' } });

describe('Admin manages groups', () => {
  it('creates, lists with member counts, renames, and returns detail', async () => {
    const created = await ctx.http().post('/api/groups').set(a.users.ADMIN.auth).send({ name: '  Safety  ' }).expect(201);
    expect(created.body.name).toBe('Safety');
    const list = await ctx.http().get('/api/groups').set(a.users.ADMIN.auth).expect(200);
    expect(list.body.map((g: { name: string }) => g.name)).toEqual(expect.arrayContaining(['General', 'Safety']));
    expect(list.body.find((g: { name: string }) => g.name === 'Safety').memberCount).toBe(0);
    await ctx.http().patch(`/api/groups/${created.body.id}`).set(a.users.ADMIN.auth).send({ name: 'Process Safety' }).expect(200);
    const detail = await ctx.http().get(`/api/groups/${created.body.id}`).set(a.users.ADMIN.auth).expect(200);
    expect(detail.body).toMatchObject({ name: 'Process Safety', members: [] });
  });

  it('group names are unique per organisation; another organisation may use the same name', async () => {
    await ctx.http().post('/api/groups').set(a.users.ADMIN.auth).send({ name: 'Operations' }).expect(201);
    await ctx.http().post('/api/groups').set(a.users.ADMIN.auth).send({ name: 'Operations' }).expect(409);
    await ctx.http().post('/api/groups').set(b.users.ADMIN.auth).send({ name: 'Operations' }).expect(201);
  });

  it('adding and removing members; a user may belong to several groups', async () => {
    const ops = await ctx.http().post('/api/groups').set(a.users.ADMIN.auth).send({ name: 'Maintenance' }).expect(201);
    const u = await a.addUser('EDITOR', 'multi');
    await ctx.http().post(`/api/groups/${ops.body.id}/members`).set(a.users.ADMIN.auth).send({ userIds: [u.user.id] }).expect(200);
    const general = await generalOf(a);
    const groupsOf = async () => (await ctx.prisma.groupMember.findMany({ where: { userId: u.user.id } })).map((m) => m.groupId).sort();
    expect(await groupsOf()).toEqual([general.id, ops.body.id].sort());
    // Removing one of two groups is fine: the user keeps another.
    await ctx.http().delete(`/api/groups/${ops.body.id}/members/${u.user.id}`).set(a.users.ADMIN.auth).expect(200);
    expect(await groupsOf()).toEqual([general.id]);
  });

  it('a non-Admin cannot be left with zero groups by removing their last membership', async () => {
    const general = await generalOf(a);
    const solo = await a.addUser('OPERATOR', 'solo');
    await ctx.http().delete(`/api/groups/${general.id}/members/${solo.user.id}`).set(a.users.ADMIN.auth).expect(409);
    expect(await ctx.prisma.groupMember.count({ where: { userId: solo.user.id } })).toBe(1);
  });

  it('deleting a group that would strand a non-Admin is refused; after moving them it succeeds', async () => {
    const temp = await ctx.http().post('/api/groups').set(a.users.ADMIN.auth).send({ name: 'Temporary' }).expect(201);
    const u = await a.addUser('OPERATOR', 'to-strand');
    await ctx.http().post(`/api/groups/${temp.body.id}/members`).set(a.users.ADMIN.auth).send({ userIds: [u.user.id] }).expect(200);
    await ctx.prisma.groupMember.deleteMany({ where: { userId: u.user.id, groupId: { not: temp.body.id } } });
    await ctx.http().delete(`/api/groups/${temp.body.id}`).set(a.users.ADMIN.auth).expect(409);
    const general = await generalOf(a);
    await ctx.http().post(`/api/groups/${general.id}/members`).set(a.users.ADMIN.auth).send({ userIds: [u.user.id] }).expect(200);
    await ctx.http().delete(`/api/groups/${temp.body.id}`).set(a.users.ADMIN.auth).expect(204);
    expect(await ctx.prisma.userGroup.findUnique({ where: { id: temp.body.id } })).toBeNull();
    expect(await ctx.prisma.groupMember.count({ where: { userId: u.user.id } })).toBe(1);
  });

  it('a group that pending work is routed to cannot be deleted', async () => {
    const t = await createTenant(ctx, 'routed');
    const general = await generalOf(t);
    const draft = await ctx.http().post('/api/kanbans').set(t.users.EDITOR.auth).send({ partCode: 'ROUTE-1', orderingType: 'email', orderingEmail: 'x@y.co' }).expect(201);
    await ctx.http().post(`/api/kanbans/revisions/${draft.body.id}/submit`).set(t.users.EDITOR.auth).expect(200);
    const r = await ctx.http().delete(`/api/groups/${general.id}`).set(t.users.ADMIN.auth).expect(409);
    expect(r.body.message).toMatch(/pending item/);
  });
});

describe('organisation isolation and role refusals', () => {
  it('another organisation cannot read, rename, delete or change members of a group', async () => {
    const g = await ctx.http().post('/api/groups').set(a.users.ADMIN.auth).send({ name: 'Private' }).expect(201);
    await ctx.http().get(`/api/groups/${g.body.id}`).set(b.users.ADMIN.auth).expect(404);
    await ctx.http().patch(`/api/groups/${g.body.id}`).set(b.users.ADMIN.auth).send({ name: 'x' }).expect(404);
    await ctx.http().delete(`/api/groups/${g.body.id}`).set(b.users.ADMIN.auth).expect(404);
    await ctx.http().post(`/api/groups/${g.body.id}/members`).set(b.users.ADMIN.auth).send({ userIds: [b.users.ADMIN.user.id] }).expect(404);
    const bList = await ctx.http().get('/api/groups').set(b.users.ADMIN.auth).expect(200);
    expect(bList.body.map((x: { id: string }) => x.id)).not.toContain(g.body.id);
  });

  it('a user from another organisation cannot be added to a group', async () => {
    const g = await ctx.http().post('/api/groups').set(a.users.ADMIN.auth).send({ name: 'Closed' }).expect(201);
    await ctx.http().post(`/api/groups/${g.body.id}/members`).set(a.users.ADMIN.auth).send({ userIds: [b.users.EDITOR.user.id] }).expect(404);
  });

  it.each(['OPERATOR', 'EDITOR', 'PRE_APPROVER', 'APPROVER'] as const)('a %s cannot manage groups (403)', async (role) => {
    await ctx.http().get('/api/groups').set(a.users[role].auth).expect(403);
    await ctx.http().post('/api/groups').set(a.users[role].auth).send({ name: 'Nope' }).expect(403);
  });
});
