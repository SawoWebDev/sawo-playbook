/** §7.4 JWT + rotating refresh token, §7.3 lockout & revocation. */
import { MAX_FAILED_LOGINS } from '../src/auth/auth.service';
import { REFRESH_COOKIE } from '../src/auth/auth.controller';
import { hashToken } from '../src/auth/token.service';
import { createTenant, createTestApp, resetDatabase, TEST_PASSWORD, TestContext } from './harness';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
  await resetDatabase(ctx.prisma);
});
afterAll(() => ctx.close());

function refreshCookieFrom(res: { headers: Record<string, unknown> }): { raw: string; header: string } {
  const cookies = ([] as string[]).concat((res.headers['set-cookie'] as string[] | string | undefined) ?? []);
  const c = cookies.find((x) => x.startsWith(`${REFRESH_COOKIE}=`));
  if (!c) throw new Error('refresh cookie not set');
  const raw = decodeURIComponent(c.split(';')[0].split('=')[1]);
  return { raw, header: `${REFRESH_COOKIE}=${raw}` };
}

async function signup(email = `owner-${Date.now()}-${Math.random()}@acme.test`) {
  const res = await ctx
    .http()
    .post('/api/auth/signup')
    .send({ organizationName: 'Acme', name: 'Olive Owner', email, password: TEST_PASSWORD })
    .expect(201);
  return { res, email };
}

describe('signup', () => {
  it('creates org + default settings + active Admin and returns an access token', async () => {
    const { res } = await signup();
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.user.role).toBe('ADMIN');
    const settings = await ctx.prisma.organizationSettings.findUnique({
      where: { organizationId: res.body.user.organizationId },
    });
    expect(settings?.approvalQuorum).toBe(3);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'org.created', organizationId: res.body.user.organizationId } })).toBe(1);
  });

  it('sets an HttpOnly, SameSite=Strict refresh cookie scoped to the refresh endpoint', async () => {
    const { res } = await signup();
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith(REFRESH_COOKIE))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/auth\/refresh/);
  });

  it('stores only the hash of the refresh token', async () => {
    const { res } = await signup();
    const { raw } = refreshCookieFrom(res);
    expect(await ctx.prisma.refreshToken.findUnique({ where: { tokenHash: raw } })).toBeNull();
    expect(await ctx.prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(raw) } })).not.toBeNull();
  });

  it('rejects client-supplied organizationId / role (whitelist validation)', async () => {
    await ctx
      .http()
      .post('/api/auth/signup')
      .send({ organizationName: 'X', name: 'Y', email: 'z@z.test', password: TEST_PASSWORD, organizationId: 'x', role: 'OWNER' })
      .expect(400);
  });

  it('rejects duplicate email', async () => {
    const { email } = await signup();
    await ctx
      .http()
      .post('/api/auth/signup')
      .send({ organizationName: 'Other', name: 'N', email, password: TEST_PASSWORD })
      .expect(409);
  });
});

describe('login / me', () => {
  it('logs in and /auth/me returns the principal derived server-side', async () => {
    const { email, res: s } = await signup();
    const res = await ctx.http().post('/api/auth/login').send({ email, password: TEST_PASSWORD }).expect(200);
    const me = await ctx.http().get('/api/auth/me').set('Authorization', `Bearer ${res.body.accessToken}`).expect(200);
    expect(me.body.organizationId).toBe(s.body.user.organizationId);
    expect(me.body.role).toBe('ADMIN');
  });

  it('rejects bad credentials with 401 and a generic message', async () => {
    const { email } = await signup();
    const res = await ctx.http().post('/api/auth/login').send({ email, password: 'wrong-password' }).expect(401);
    expect(res.body.message).toBe('Invalid credentials');
    await ctx.http().post('/api/auth/login').send({ email: 'nobody@nowhere.test', password: 'x' }).expect(401);
  });

  it(`locks the account after ${MAX_FAILED_LOGINS} failures, even for the right password`, async () => {
    const { email } = await signup();
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await ctx.http().post('/api/auth/login').send({ email, password: 'wrong-password' }).expect(401);
    }
    const res = await ctx.http().post('/api/auth/login').send({ email, password: TEST_PASSWORD }).expect(401);
    expect(res.body.message).toMatch(/locked/i);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'auth.login.locked' } })).toBeGreaterThan(0);
  });

  it('rejects requests without / with a garbage token', async () => {
    await ctx.http().get('/api/auth/me').expect(401);
    await ctx.http().get('/api/auth/me').set('Authorization', 'Bearer not-a-jwt').expect(401);
  });
});

describe('refresh token rotation (§7.4)', () => {
  it('rotates on every refresh and invalidates the old token', async () => {
    const { res } = await signup();
    const first = refreshCookieFrom(res);
    const r1 = await ctx.http().post('/api/auth/refresh').set('Cookie', first.header).expect(200);
    const second = refreshCookieFrom(r1);
    expect(second.raw).not.toBe(first.raw);
    const old = await ctx.prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: hashToken(first.raw) } });
    expect(old.rotatedAt).not.toBeNull();
    await ctx.http().post('/api/auth/refresh').set('Cookie', second.header).expect(200);
  });

  it('reuse of a rotated token revokes the whole family', async () => {
    const { res } = await signup();
    const first = refreshCookieFrom(res);
    const r1 = await ctx.http().post('/api/auth/refresh').set('Cookie', first.header).expect(200);
    const second = refreshCookieFrom(r1);

    // attacker replays the first token
    await ctx.http().post('/api/auth/refresh').set('Cookie', first.header).expect(401);
    // legitimate holder's newer token is now dead too
    await ctx.http().post('/api/auth/refresh').set('Cookie', second.header).expect(401);

    const rec = await ctx.prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: hashToken(second.raw) } });
    expect(rec.revokedAt).not.toBeNull();
    expect(rec.revokeReason).toBe('reuse_detected');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'auth.refresh.reuse_detected', actorId: res.body.user.id } })).toBe(1);
  });

  it('concurrent refreshes with the same token: at most one succeeds', async () => {
    const { res } = await signup();
    const first = refreshCookieFrom(res);
    const results = await Promise.all([
      ctx.http().post('/api/auth/refresh').set('Cookie', first.header),
      ctx.http().post('/api/auth/refresh').set('Cookie', first.header),
    ]);
    expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
  });

  it('logout revokes the family', async () => {
    const { res } = await signup();
    const first = refreshCookieFrom(res);
    await ctx.http().post('/api/auth/refresh/logout').set('Cookie', first.header).expect(204);
    await ctx.http().post('/api/auth/refresh').set('Cookie', first.header).expect(401);
  });

  it('missing / unknown cookie ⇒ 401', async () => {
    await ctx.http().post('/api/auth/refresh').expect(401);
    await ctx.http().post('/api/auth/refresh').set('Cookie', `${REFRESH_COOKIE}=nope`).expect(401);
  });
});

describe('revocation on role change / removal / password reset (§7.3 rule 7)', () => {
  it('revokeAllForUser kills outstanding access tokens and every refresh family', async () => {
    const tenant = await createTenant(ctx, 'revoke');
    const editor = tenant.users.EDITOR;
    const login = await ctx.http().post('/api/auth/login').send({ email: editor.user.email, password: TEST_PASSWORD }).expect(200);
    const cookie = refreshCookieFrom(login);

    await ctx.http().get('/api/auth/me').set(editor.auth).expect(200);
    await ctx.tokens.revokeAllForUser(editor.user.id, 'role_change');

    await ctx.http().get('/api/auth/me').set(editor.auth).expect(401);
    await ctx.http().get('/api/auth/me').set('Authorization', `Bearer ${login.body.accessToken}`).expect(401);
    await ctx.http().post('/api/auth/refresh').set('Cookie', cookie.header).expect(401);
  });

  it('suspended users cannot use existing access tokens', async () => {
    const tenant = await createTenant(ctx, 'suspend');
    const op = tenant.users.OPERATOR;
    await ctx.prisma.user.update({ where: { id: op.user.id }, data: { status: 'suspended' } });
    await ctx.http().get('/api/auth/me').set(op.auth).expect(401);
  });

  it('tokens of a suspended organization are rejected', async () => {
    const tenant = await createTenant(ctx, 'orgsusp');
    await ctx.prisma.organization.update({ where: { id: tenant.organizationId }, data: { status: 'suspended' } });
    await ctx.http().get('/api/auth/me').set(tenant.users.OWNER.auth).expect(401);
  });
});
