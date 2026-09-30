/** MFA (TOTP) — enrolment, two-step login, replay protection, disable, admin reset. */
import { base32Encode, currentStep, decryptSecret, encryptSecret, totpAt, verifyTotp } from '../src/auth/totp';
import { createTenant, createTestApp, expectCrossTenantNotFound, resetDatabase, Tenant, TenantUser, TEST_PASSWORD, TestContext } from './harness';

let ctx: TestContext;
let a: Tenant;
let b: Tenant;

beforeAll(async () => {
  ctx = await createTestApp();
  await resetDatabase(ctx.prisma);
  a = await createTenant(ctx, 'alpha');
  b = await createTenant(ctx, 'beta');
});
afterAll(() => ctx.close());

describe('TOTP primitives', () => {
  it('matches the RFC 6238 SHA-1 test vector', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(totpAt(secret, 1)).toBe('287082'); // T = 59 s
    expect(totpAt(secret, 37037036)).toBe('081804'); // T = 1111111109 s
  });

  it('accepts ±1 step of drift only', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const now = 1_111_111_109_000;
    const step = currentStep(now);
    expect(verifyTotp(secret, totpAt(secret, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, totpAt(secret, step + 2), now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });

  it('encrypts secrets with authenticated encryption', () => {
    const blob = encryptSecret('JBSWY3DPEHPK3PXP');
    expect(blob).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(blob)).toBe('JBSWY3DPEHPK3PXP');
    const tampered = blob.slice(0, -2) + (blob.endsWith('A') ? 'B' : 'A') + blob.slice(-1);
    expect(() => decryptSecret(tampered)).toThrow();
  });
});

async function enrol(tu: TenantUser): Promise<{ secret: string; auth: { Authorization: string } }> {
  const setup = await ctx.http().post('/api/profile/mfa/setup').set(tu.auth).expect(200);
  expect(setup.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
  expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
  await ctx.http().post('/api/profile/mfa/enable').set(tu.auth).send({ code: '000000' }).expect(400);
  const en = await ctx.http().post('/api/profile/mfa/enable').set(tu.auth).send({ code: totpAt(setup.body.secret, currentStep()) }).expect(200);
  return { secret: setup.body.secret, auth: { Authorization: `Bearer ${en.body.accessToken}` } };
}

describe('MFA enrolment and login', () => {
  it('enable → password step returns a challenge → code completes login; secrets are stored encrypted', async () => {
    const u = await a.addUser('EDITOR', 'mfa1');
    const { secret, auth } = await enrol(u);
    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: u.user.id } });
    expect(row.mfaEnabled).toBe(true);
    expect(row.mfaSecretEnc).not.toContain(secret);
    expect(row.mfaPendingSecretEnc).toBeNull();
    // enabling revoked the old session; the returned one works
    await ctx.http().get('/api/auth/me').set(u.auth).expect(401);
    await ctx.http().get('/api/auth/me').set(auth).expect(200);
    expect((await ctx.http().get('/api/profile').set(auth).expect(200)).body.mfaEnabled).toBe(true);

    const step1 = await ctx.http().post('/api/auth/login').send({ email: u.user.email, password: TEST_PASSWORD }).expect(200);
    expect(step1.body).toEqual({ mfaRequired: true, mfaToken: expect.any(String) });
    expect(step1.headers['set-cookie']).toBeUndefined();

    await ctx.http().post('/api/auth/login/mfa').send({ mfaToken: step1.body.mfaToken, code: '123456' }).expect(401);
    // the enable step consumed the current time-step, so use the next one (still within the ±1 window)
    const code = totpAt(secret, currentStep() + 1);
    const ok = await ctx.http().post('/api/auth/login/mfa').send({ mfaToken: step1.body.mfaToken, code }).expect(200);
    expect(ok.body.accessToken).toEqual(expect.any(String));
    // replaying the same code is rejected
    const again = await ctx.http().post('/api/auth/login').send({ email: u.user.email, password: TEST_PASSWORD }).expect(200);
    await ctx.http().post('/api/auth/login/mfa').send({ mfaToken: again.body.mfaToken, code }).expect(401);
  });

  it('forged or expired MFA tokens are rejected', async () => {
    await ctx.http().post('/api/auth/login/mfa').send({ mfaToken: 'x'.repeat(40), code: '123456' }).expect(401);
    // an access token cannot be used as an MFA token (audience check)
    await ctx.http().post('/api/auth/login/mfa').send({ mfaToken: a.users.OWNER.token, code: '123456' }).expect(401);
  });

  it('bad codes count toward lockout', async () => {
    const u = await a.addUser('OPERATOR', 'mfa-lock');
    await enrol(u);
    for (let i = 0; i < 5; i++) {
      const s = await ctx.http().post('/api/auth/login').send({ email: u.user.email, password: TEST_PASSWORD }).expect(200);
      await ctx.http().post('/api/auth/login/mfa').send({ mfaToken: s.body.mfaToken, code: '000000' }).expect(401);
    }
    await ctx.http().post('/api/auth/login').send({ email: u.user.email, password: TEST_PASSWORD }).expect(401);
  });

  it('disable requires password and a valid code', async () => {
    const u = await a.addUser('EDITOR', 'mfa-off');
    const { secret, auth } = await enrol(u);
    await ctx.http().post('/api/profile/mfa/disable').set(auth).send({ password: 'wrong', code: totpAt(secret, currentStep()) }).expect(401);
    await ctx.http().post('/api/profile/mfa/disable').set(auth).send({ password: TEST_PASSWORD, code: '000000' }).expect(400);
    const r = await ctx.http().post('/api/profile/mfa/disable').set(auth).send({ password: TEST_PASSWORD, code: totpAt(secret, currentStep()) }).expect(200);
    expect(r.body.mfaEnabled).toBe(false);
    const login = await ctx.http().post('/api/auth/login').send({ email: u.user.email, password: TEST_PASSWORD }).expect(200);
    expect(login.body.accessToken).toEqual(expect.any(String));
  });
});

describe('admin MFA reset', () => {
  it('Admin resets a user’s MFA (sessions revoked); cannot reset Owner; cross-tenant 404; audited', async () => {
    const u = await a.addUser('OPERATOR', 'mfa-reset');
    const { auth } = await enrol(u);
    const r = await ctx.http().post(`/api/users/${u.user.id}/mfa/reset`).set(a.users.ADMIN.auth).expect(200);
    expect(r.body.mfaEnabled).toBe(false);
    await ctx.http().get('/api/auth/me').set(auth).expect(401);
    await ctx.http().post(`/api/users/${a.users.OWNER.user.id}/mfa/reset`).set(a.users.ADMIN.auth).expect(403);
    await ctx.http().post(`/api/users/${u.user.id}/mfa/reset`).set(a.users.EDITOR.auth).expect(403);
    await expectCrossTenantNotFound(() => ctx.http().post(`/api/users/${u.user.id}/mfa/reset`).set(b.users.OWNER.auth));
    expect(await ctx.prisma.auditLog.count({ where: { action: 'auth.mfa.changed', entityId: u.user.id } })).toBe(2);
  });
});
