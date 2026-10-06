/** Invitations and role assignment: only the five application roles can be granted; the server decides the role on acceptance. */
import { hashToken } from '../src/auth/token.service';
import { OrgRole } from '@prisma/client';
import { createTenant, createTestApp, resetDatabase, Tenant, TestContext, TEST_PASSWORD } from './harness';

let ctx: TestContext;
let t: Tenant;
let general: { id: string };

beforeAll(async () => {
  ctx = await createTestApp();
  await resetDatabase(ctx.prisma);
  t = await createTenant(ctx, 'invites');
  general = await ctx.prisma.userGroup.findFirstOrThrow({ where: { organizationId: t.organizationId, name: 'General' } });
});
afterAll(() => ctx.close());

const email = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@invites.test`;
const admin = () => t.users.ADMIN.auth;

/** Invites as the tenant Admin and returns the one-time token from the invite URL. */
async function invite(role: string, groupIds: string[] | undefined, who = email(role.toLowerCase())) {
  const res = await ctx.http().post('/api/users/invitations').set(role === 'ADMIN' ? t.users.OWNER.auth : admin()).send({ email: who, role, ...(groupIds ? { groupIds } : {}) });
  return { res, token: res.body.inviteUrl ? String(res.body.inviteUrl).split('/').pop() : undefined, email: who };
}

const accept = (token: string, body: object = {}) =>
  ctx.http().post('/api/auth/accept-invite').send({ token, name: 'Newcomer', password: TEST_PASSWORD, ...body });

describe('acceptance of each of the five roles', () => {
  it.each(['ADMIN', 'OPERATOR', 'EDITOR', 'PRE_APPROVER', 'APPROVER'] as const)('a pending %s invitation is accepted as %s', async (role) => {
    const groups = role === 'ADMIN' ? undefined : [general.id];
    const inv = await invite(role, groups);
    expect(inv.res.status).toBe(201);
    const acc = await accept(inv.token!).expect(201);
    expect(acc.body.user.role).toBe(role);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email: inv.email } });
    expect(user.orgRole).toBe(role);
    const memberships = await ctx.prisma.groupMember.count({ where: { userId: user.id } });
    expect(memberships).toBe(role === 'ADMIN' ? 0 : 1);
  });

  it('a non-Admin invitation makes the new person a member of the invited group (it was previously dropped)', async () => {
    const inv = await invite('EDITOR', [general.id]);
    await accept(inv.token!).expect(201);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email: inv.email } });
    const member = await ctx.prisma.groupMember.findFirstOrThrow({ where: { userId: user.id } });
    expect(member.groupId).toBe(general.id);
  });
});

describe('legacy roles can never be invited, accepted or assigned', () => {
  it.each(['OWNER', 'TRAINER'])('inviting %s through the API is refused', async (role) => {
    const r = await ctx.http().post('/api/users/invitations').set(admin()).send({ email: email('legacy'), role, groupIds: [general.id] });
    expect(r.status).toBe(400);
  });

  it.each(['OWNER', 'TRAINER'])('a pending %s invitation that exists in the database cannot be accepted or described', async (role) => {
    const token = `legacy-${role.toLowerCase()}-${Math.random().toString(36).repeat(3)}`.slice(0, 60);
    await ctx.prisma.invitation.create({
      data: { organizationId: t.organizationId, email: email(role.toLowerCase()), orgRole: role as OrgRole, tokenHash: hashToken(token), status: 'pending', invitedById: t.users.ADMIN.user.id, expiresAt: new Date(Date.now() + 86_400_000) },
    });
    await ctx.http().get(`/api/auth/invitations/${token}`).expect(404);
    await accept(token).expect(404);
  });

  it('a pending invitation of a valid role but whose groups were all deleted is refused and stays usable for an Admin to fix', async () => {
    const tmpGroup = await ctx.prisma.userGroup.create({ data: { organizationId: t.organizationId, name: 'Temporary' } });
    const inv = await invite('EDITOR', [tmpGroup.id]);
    expect(inv.res.status).toBe(201);
    await ctx.prisma.userGroup.delete({ where: { id: tmpGroup.id } });
    await accept(inv.token!).expect(409);
    const row = await ctx.prisma.invitation.findFirstOrThrow({ where: { email: inv.email } });
    expect(row.status).toBe('pending');
    expect(await ctx.prisma.user.count({ where: { email: inv.email } })).toBe(0);
  });
});

describe('the server, not the client, decides the role', () => {
  it('a role sent with the acceptance is refused, and the invited role is what gets created', async () => {
    const inv = await invite('EDITOR', [general.id]);
    await accept(inv.token!, { role: 'ADMIN' }).expect(400);
    expect(await ctx.prisma.user.count({ where: { email: inv.email } })).toBe(0);
    await accept(inv.token!).expect(201);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { email: inv.email } })).orgRole).toBe('EDITOR');
  });

  it('an invitation for a non-Admin role must name at least one group', async () => {
    const r = await invite('APPROVER', []);
    expect(r.res.status).toBe(400);
  });

  it('an invitation naming a group from another organisation is refused', async () => {
    const other = await createTenant(ctx, 'other-org');
    const foreign = await ctx.prisma.userGroup.findFirstOrThrow({ where: { organizationId: other.organizationId, name: 'General' } });
    const r = await invite('EDITOR', [foreign.id]);
    expect(r.res.status).toBe(400);
  });
});

describe('bulk invite uses the same validation', () => {
  it('CSV rows with a groups column are created with that group; unknown groups and legacy roles fail only their row', async () => {
    await ctx.prisma.userGroup.create({ data: { organizationId: t.organizationId, name: 'Safety' } });
    const who = [email('csv-a'), email('csv-b'), email('csv-c'), email('csv-d')];
    const csv = [
      'email,role,groups',
      `${who[0]},Editor,General`,
      `${who[1]},Editor,Nowhere`,
      `${who[2]},Owner,General`,
      `${who[3]},Approver,General;Safety`,
    ].join('\n');
    const r = await ctx.http().post('/api/users/invitations/bulk').set(admin()).send({ csv }).expect(201);
    expect(r.body.created.map((c: { email: string }) => c.email).sort()).toEqual([who[0], who[3]].sort());
    expect(r.body.errors.map((e: { row: number }) => e.row)).toEqual([3, 4]);
    const inv = await ctx.prisma.invitation.findFirstOrThrow({ where: { email: who[3], status: 'pending' } });
    expect(inv.groupIds).toHaveLength(2);
  });

  it('a structured bulk row with a Trainer role is rejected by the DTO', async () => {
    await ctx.http().post('/api/users/invitations/bulk').set(admin()).send({ invites: [{ email: email('x'), role: 'TRAINER' }] }).expect(400);
  });
});

describe('role changes use the same five-role set and group rule', () => {
  it('Owner and Trainer cannot be assigned by role change', async () => {
    const u = await t.addUser('EDITOR', 'to-change');
    await ctx.http().patch(`/api/users/${u.user.id}/role`).set(admin()).send({ role: 'OWNER' }).expect(400);
    await ctx.http().patch(`/api/users/${u.user.id}/role`).set(admin()).send({ role: 'TRAINER' }).expect(400);
  });

  it('an Admin without groups cannot be given a non-Admin role until a group is assigned', async () => {
    // Admins cannot modify other Admins, so the change is made by the full-access account.
    const admin2 = await t.addUser('ADMIN', 'demote-me');
    await ctx.http().patch(`/api/users/${admin2.user.id}/role`).set(t.users.OWNER.auth).send({ role: 'EDITOR' }).expect(400);
    await ctx.prisma.groupMember.create({ data: { groupId: general.id, userId: admin2.user.id, organizationId: t.organizationId } });
    await ctx.http().patch(`/api/users/${admin2.user.id}/role`).set(t.users.OWNER.auth).send({ role: 'EDITOR' }).expect(200);
  });
});
