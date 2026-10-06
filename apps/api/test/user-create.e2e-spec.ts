/** Admin-created accounts with a temporary password: role/group rules, forced password change, audit (no secrets). */
import { createTenant, createTestApp, resetDatabase, Tenant, TestContext } from './harness';

let ctx: TestContext;
let t: Tenant;
let general: { id: string };

const TEMP = 'Temporary-pass-123';
const NEW = 'A-brand-new-password-456';
const rand = () => Math.random().toString(36).slice(2, 8);

beforeAll(async () => {
  ctx = await createTestApp();
  await resetDatabase(ctx.prisma);
  t = await createTenant(ctx, 'create-user');
  general = await ctx.prisma.userGroup.findFirstOrThrow({ where: { organizationId: t.organizationId, name: 'General' } });
});
afterAll(() => ctx.close());

const create = (auth: { Authorization: string }, body: object) => ctx.http().post('/api/users').set(auth).send(body);
const as = (role: 'ADMIN' | 'EDITOR') => t.users[role].auth;
const login = (email: string, password: string) => ctx.http().post('/api/auth/login').send({ email, password });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function createEditor(extra: object = {}) {
  const email = `new-${rand()}@create.test`;
  const res = await create(as('ADMIN'), { name: 'New Person', email, role: 'EDITOR', groupIds: [general.id], temporaryPassword: TEMP, ...extra });
  // Surface the server's reason on failure instead of only the status code.
  if (res.status !== 201) throw new Error(`createUser ${res.status}: ${JSON.stringify(res.body)}`);
  return { email, res };
}

describe('creating an account', () => {
  it('an Admin creates a grouped Editor; the response carries no password and the stored value is hashed', async () => {
    const { email, res } = await createEditor();
    expect(res.body).toMatchObject({ email, role: 'EDITOR', groupIds: [general.id], passwordMustChange: true });
    expect(JSON.stringify(res.body)).not.toContain(TEMP);
    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(row.passwordHash).toMatch(/^\$argon2/);
    expect(row.passwordMustChange).toBe(true);
    expect(row.status).toBe('active');
  });

  it('a non-Admin role without a group is refused; an Admin cannot create another Admin', async () => {
    const email = `nogroup-${rand()}@create.test`;
    await create(as('ADMIN'), { name: 'No Group', email, role: 'APPROVER', groupIds: [], temporaryPassword: TEMP }).expect(400);
    // Existing invariant: Admins cannot grant the Admin role (same rule as invitations).
    await create(as('ADMIN'), { name: 'Second Admin', email: `admin-${rand()}@create.test`, role: 'ADMIN', temporaryPassword: TEMP }).expect(403);
  });

  it('a duplicate email is a conflict and a short temporary password is refused', async () => {
    const { email } = await createEditor();
    await create(as('ADMIN'), { name: 'Dup', email, role: 'EDITOR', groupIds: [general.id], temporaryPassword: TEMP }).expect(409);
    await create(as('ADMIN'), { name: 'Short', email: `short-${rand()}@create.test`, role: 'EDITOR', groupIds: [general.id], temporaryPassword: 'short' }).expect(400);
  });

  it('an Editor cannot create accounts', async () => {
    await create(as('EDITOR'), { name: 'Nope', email: `nope-${rand()}@create.test`, role: 'EDITOR', groupIds: [general.id], temporaryPassword: TEMP }).expect(403);
  });

  it('the creation is audited without the password', async () => {
    const { email } = await createEditor();
    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    const logs = await ctx.prisma.auditLog.findMany({ where: { organizationId: t.organizationId, action: 'user.created', entityId: row.id } });
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs[0].metadata)).not.toContain(TEMP);
  });
});

describe('the temporary password forces a change before anything else', () => {
  it('the user logs in, can read their identity, but every other route is refused until they change the password', async () => {
    const { email } = await createEditor();
    const session = await login(email, TEMP).expect(200);
    expect(session.body.user.passwordMustChange).toBe(true);

    const me = await ctx.http().get('/api/auth/me').set(bearer(session.body.accessToken)).expect(200);
    expect(me.body.passwordMustChange).toBe(true);

    const blocked = await ctx.http().get('/api/kanbans').set(bearer(session.body.accessToken)).expect(403);
    expect(blocked.body.message).toMatch(/Password change required/);
  });

  it('changing the password clears the requirement; the old password stops working', async () => {
    const { email } = await createEditor();
    const session = await login(email, TEMP).expect(200);

    await ctx.http().post('/api/profile/password').set(bearer(session.body.accessToken)).send({ currentPassword: TEMP, newPassword: NEW }).expect(200);

    const next = await login(email, NEW).expect(200);
    expect(next.body.user.passwordMustChange).toBe(false);
    await ctx.http().get('/api/kanbans').set(bearer(next.body.accessToken)).expect(200);
    await login(email, TEMP).expect(401);
  });

  it('a wrong current password does not clear the requirement', async () => {
    const { email } = await createEditor();
    const session = await login(email, TEMP).expect(200);
    await ctx.http().post('/api/profile/password').set(bearer(session.body.accessToken)).send({ currentPassword: 'not-it-at-all', newPassword: NEW }).expect(401);
    await ctx.http().get('/api/kanbans').set(bearer(session.body.accessToken)).expect(403);
  });

  it('accounts that were not created this way are unaffected', async () => {
    const session = await login(t.users.EDITOR.user.email, 'correct-horse-battery-staple').expect(200);
    await ctx.http().get('/api/kanbans').set(bearer(session.body.accessToken)).expect(200);
  });
});
