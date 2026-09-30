/** Phase 0.5 — user management, invitations, self-service, org settings, audit (§7.2, §7.5, §7.6, §7.7). */
import { MailService } from '../src/mail/mail.service';
import { parseInviteCsv } from '../src/users/users.service';
import {
  createTenant,
  createTestApp,
  expectCrossTenantNotFound,
  refreshAuth,
  resetDatabase,
  Tenant,
  TEST_PASSWORD,
  TestContext,
} from './harness';

let ctx: TestContext;
let mail: MailService;
let a: Tenant;
let b: Tenant;

beforeAll(async () => {
  ctx = await createTestApp();
  mail = ctx.app.get(MailService);
  await resetDatabase(ctx.prisma);
  a = await createTenant(ctx, 'alpha');
  b = await createTenant(ctx, 'beta');
});
afterAll(() => ctx.close());

const uniqueEmail = (p = 'invitee') => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;

function tokenFromMail(email: string, pathPart: string): string {
  const m = mail.lastTo(email);
  if (!m) throw new Error(`no mail to ${email}`);
  const match = m.text.match(new RegExp(`/${pathPart}/([A-Za-z0-9_-]+)`));
  if (!match) throw new Error('token not found in mail');
  return match[1];
}

describe('list users', () => {
  it('Owner/Admin see only their own org', async () => {
    const res = await ctx.http().get('/api/users').set(a.users.ADMIN.auth).expect(200);
    const ids = res.body.map((u: { id: string }) => u.id);
    expect(ids).toContain(a.users.EDITOR.user.id);
    expect(ids).not.toContain(b.users.EDITOR.user.id);
    expect(res.body[0]).not.toHaveProperty('passwordHash');
  });

  it.each(['EDITOR', 'APPROVER', 'TRAINER', 'OPERATOR'] as const)('%s gets 403', async (role) => {
    await ctx.http().get('/api/users').set(a.users[role].auth).expect(403);
  });
});

describe('invitations', () => {
  it('invite → describe → accept creates an active user with the invited role', async () => {
    const email = uniqueEmail();
    const inv = await ctx.http().post('/api/users/invitations').set(a.users.ADMIN.auth).send({ email, role: 'EDITOR' }).expect(201);
    expect(inv.body.inviteUrl).toMatch(/\/invite\//);
    const token = tokenFromMail(email, 'invite');

    const desc = await ctx.http().get(`/api/auth/invitations/${token}`).expect(200);
    expect(desc.body).toMatchObject({ email, role: 'EDITOR' });

    const acc = await ctx.http().post('/api/auth/accept-invite').send({ token, name: 'New Editor', password: TEST_PASSWORD }).expect(201);
    expect(acc.body.user).toMatchObject({ email, role: 'EDITOR', organizationId: a.organizationId });
    await ctx.http().get('/api/auth/me').set('Authorization', `Bearer ${acc.body.accessToken}`).expect(200);

    // single-use
    await ctx.http().post('/api/auth/accept-invite').send({ token, name: 'Again', password: TEST_PASSWORD }).expect(404);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'user.invite.accepted', organizationId: a.organizationId } })).toBeGreaterThan(0);
  });

  it('re-inviting the same email supersedes the previous invitation', async () => {
    const email = uniqueEmail();
    await ctx.http().post('/api/users/invitations').set(a.users.OWNER.auth).send({ email, role: 'OPERATOR' }).expect(201);
    const first = tokenFromMail(email, 'invite');
    await ctx.http().post('/api/users/invitations').set(a.users.OWNER.auth).send({ email, role: 'TRAINER' }).expect(201);
    await ctx.http().get(`/api/auth/invitations/${first}`).expect(404);
    const second = tokenFromMail(email, 'invite');
    const d = await ctx.http().get(`/api/auth/invitations/${second}`).expect(200);
    expect(d.body.role).toBe('TRAINER');
  });

  it('rejects inviting an existing user', async () => {
    await ctx.http().post('/api/users/invitations').set(a.users.OWNER.auth).send({ email: b.users.EDITOR.user.email, role: 'EDITOR' }).expect(409);
  });

  it('nobody can invite an OWNER; Admin cannot invite an ADMIN; Owner can', async () => {
    await ctx.http().post('/api/users/invitations').set(a.users.OWNER.auth).send({ email: uniqueEmail(), role: 'OWNER' }).expect(403);
    await ctx.http().post('/api/users/invitations').set(a.users.ADMIN.auth).send({ email: uniqueEmail(), role: 'ADMIN' }).expect(403);
    await ctx.http().post('/api/users/invitations').set(a.users.OWNER.auth).send({ email: uniqueEmail(), role: 'ADMIN' }).expect(201);
  });

  it('Editor cannot invite', async () => {
    await ctx.http().post('/api/users/invitations').set(a.users.EDITOR.auth).send({ email: uniqueEmail(), role: 'OPERATOR' }).expect(403);
  });

  it('revoked invitations cannot be accepted; cross-tenant revoke is 404', async () => {
    const email = uniqueEmail();
    const inv = await ctx.http().post('/api/users/invitations').set(a.users.OWNER.auth).send({ email, role: 'OPERATOR' }).expect(201);
    const token = tokenFromMail(email, 'invite');
    await expectCrossTenantNotFound(() => ctx.http().delete(`/api/users/invitations/${inv.body.id}`).set(b.users.OWNER.auth));
    await ctx.http().delete(`/api/users/invitations/${inv.body.id}`).set(a.users.OWNER.auth).expect(204);
    await ctx.http().post('/api/auth/accept-invite').send({ token, name: 'X', password: TEST_PASSWORD }).expect(404);
  });

  it('expired invitations cannot be accepted', async () => {
    const email = uniqueEmail();
    const inv = await ctx.http().post('/api/users/invitations').set(a.users.OWNER.auth).send({ email, role: 'OPERATOR' }).expect(201);
    await ctx.prisma.invitation.update({ where: { id: inv.body.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const token = tokenFromMail(email, 'invite');
    await ctx.http().post('/api/auth/accept-invite').send({ token, name: 'X', password: TEST_PASSWORD }).expect(404);
  });

  it('bulk CSV invite reports per-row results', async () => {
    const e1 = uniqueEmail('bulk1');
    const e2 = uniqueEmail('bulk2');
    const csv = `email,role\n${e1},editor\nnot-an-email,operator\n${e2},OWNER\n${e1},trainer\n`;
    const res = await ctx.http().post('/api/users/invitations/bulk').set(a.users.ADMIN.auth).send({ csv }).expect(201);
    expect(res.body.created.map((c: { email: string }) => c.email)).toEqual([e1]);
    expect(res.body.errors).toHaveLength(3);
  });

  it('CSV parser handles quotes, BOM and missing header', () => {
    expect(parseInviteCsv('﻿role,email\nEDITOR,"a@b.co"\n')).toEqual([{ row: 2, email: 'a@b.co', role: 'EDITOR' }]);
    expect(parseInviteCsv('x@y.co,operator')).toEqual([{ row: 1, email: 'x@y.co', role: 'operator' }]);
  });
});

describe('role change / suspend / remove', () => {
  it('Owner changes a role; the target’s tokens are revoked immediately', async () => {
    const t = await a.addUser('OPERATOR', 'promote');
    await ctx.http().get('/api/auth/me').set(t.auth).expect(200);
    const res = await ctx.http().patch(`/api/users/${t.user.id}/role`).set(a.users.OWNER.auth).send({ role: 'EDITOR' }).expect(200);
    expect(res.body.orgRole).toBe('EDITOR');
    await ctx.http().get('/api/auth/me').set(t.auth).expect(401);
    const fresh = await refreshAuth(ctx, t);
    const me = await ctx.http().get('/api/auth/me').set(fresh.auth).expect(200);
    expect(me.body.role).toBe('EDITOR');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'user.role.changed', entityId: t.user.id } })).toBe(1);
  });

  it('Admin cannot change Owner/Admin or grant Admin', async () => {
    const other = await a.addUser('ADMIN', 'admin2');
    const op = await a.addUser('OPERATOR', 'op2');
    await ctx.http().patch(`/api/users/${a.users.OWNER.user.id}/role`).set(a.users.ADMIN.auth).send({ role: 'EDITOR' }).expect(403);
    await ctx.http().patch(`/api/users/${other.user.id}/role`).set(a.users.ADMIN.auth).send({ role: 'EDITOR' }).expect(403);
    await ctx.http().patch(`/api/users/${op.user.id}/role`).set(a.users.ADMIN.auth).send({ role: 'ADMIN' }).expect(403);
    await ctx.http().patch(`/api/users/${op.user.id}/role`).set(a.users.ADMIN.auth).send({ role: 'TRAINER' }).expect(200);
  });

  it('cannot change your own role', async () => {
    await ctx.http().patch(`/api/users/${a.users.ADMIN.user.id}/role`).set(a.users.ADMIN.auth).send({ role: 'EDITOR' }).expect(403);
  });

  it('suspend blocks login and tokens; reactivate restores login', async () => {
    const t = await a.addUser('EDITOR', 'susp');
    await ctx.http().post(`/api/users/${t.user.id}/suspend`).set(a.users.ADMIN.auth).expect(200);
    await ctx.http().get('/api/auth/me').set(t.auth).expect(401);
    await ctx.http().post('/api/auth/login').send({ email: t.user.email, password: TEST_PASSWORD }).expect(401);
    await ctx.http().post(`/api/users/${t.user.id}/reactivate`).set(a.users.ADMIN.auth).expect(200);
    await ctx.http().post('/api/auth/login').send({ email: t.user.email, password: TEST_PASSWORD }).expect(200);
  });

  it('remove is permanent and keeps the row (Invariant #16)', async () => {
    const t = await a.addUser('EDITOR', 'rm');
    const res = await ctx.http().post(`/api/users/${t.user.id}/remove`).set(a.users.OWNER.auth).expect(200);
    expect(res.body.status).toBe('removed');
    await ctx.http().post(`/api/users/${t.user.id}/reactivate`).set(a.users.OWNER.auth).expect(400);
    await ctx.http().post('/api/auth/login').send({ email: t.user.email, password: TEST_PASSWORD }).expect(401);
    expect(await ctx.prisma.user.findUnique({ where: { id: t.user.id } })).not.toBeNull();
  });

  it('cross-tenant: every user mutation on another org’s user returns 404', async () => {
    const victim = b.users.EDITOR.user.id;
    await expectCrossTenantNotFound(() => ctx.http().patch(`/api/users/${victim}/role`).set(a.users.OWNER.auth).send({ role: 'OPERATOR' }));
    await expectCrossTenantNotFound(() => ctx.http().post(`/api/users/${victim}/suspend`).set(a.users.OWNER.auth));
    await expectCrossTenantNotFound(() => ctx.http().post(`/api/users/${victim}/reactivate`).set(a.users.OWNER.auth));
    await expectCrossTenantNotFound(() => ctx.http().post(`/api/users/${victim}/remove`).set(a.users.OWNER.auth));
    const still = await ctx.prisma.user.findUniqueOrThrow({ where: { id: victim } });
    expect(still.status).toBe('active');
    expect(still.orgRole).toBe('EDITOR');
  });

  it('non-UUID ids are rejected with 400, not 500', async () => {
    await ctx.http().post('/api/users/not-a-uuid/suspend').set(a.users.OWNER.auth).expect(400);
  });
});

describe('self-service profile & passwords', () => {
  it('updates own name', async () => {
    const t = await a.addUser('OPERATOR', 'prof');
    const res = await ctx.http().patch('/api/profile').set(t.auth).send({ name: 'Renamed' }).expect(200);
    expect(res.body.name).toBe('Renamed');
  });

  it('password change revokes old sessions and returns a new one', async () => {
    const t = await a.addUser('OPERATOR', 'pw');
    await ctx.http().post('/api/profile/password').set(t.auth).send({ currentPassword: 'wrong', newPassword: 'a-brand-new-password' }).expect(401);
    const res = await ctx
      .http()
      .post('/api/profile/password')
      .set(t.auth)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'a-brand-new-password' })
      .expect(200);
    await ctx.http().get('/api/auth/me').set(t.auth).expect(401);
    await ctx.http().get('/api/auth/me').set('Authorization', `Bearer ${res.body.accessToken}`).expect(200);
    await ctx.http().post('/api/auth/login').send({ email: t.user.email, password: 'a-brand-new-password' }).expect(200);
  });

  it('forgot/reset password flow: single-use token, revokes sessions, no enumeration', async () => {
    const t = await a.addUser('OPERATOR', 'reset');
    await ctx.http().post('/api/auth/forgot-password').send({ email: 'nobody@example.test' }).expect(204);
    await ctx.http().post('/api/auth/forgot-password').send({ email: t.user.email }).expect(204);
    const token = tokenFromMail(t.user.email, 'reset-password');
    await ctx.http().post('/api/auth/reset-password').send({ token, newPassword: 'reset-password-123' }).expect(204);
    await ctx.http().post('/api/auth/reset-password').send({ token, newPassword: 'reset-password-456' }).expect(400);
    await ctx.http().get('/api/auth/me').set(t.auth).expect(401);
    await ctx.http().post('/api/auth/login').send({ email: t.user.email, password: 'reset-password-123' }).expect(200);
  });
});

describe('organization settings (§6.1a)', () => {
  it('any member can read; only Owner/Admin can update; change is audited', async () => {
    const r = await ctx.http().get('/api/organization').set(a.users.OPERATOR.auth).expect(200);
    expect(r.body.settings).toMatchObject({ approvalQuorum: 3, allowSelfApproval: false, publicSopViewing: false });
    await ctx.http().patch('/api/organization/settings').set(a.users.EDITOR.auth).send({ approvalQuorum: 2 }).expect(403);
    const u = await ctx.http().patch('/api/organization/settings').set(a.users.ADMIN.auth).send({ approvalQuorum: 2 }).expect(200);
    expect(u.body.settings.approvalQuorum).toBe(2);
    await ctx.http().patch('/api/organization/settings').set(a.users.ADMIN.auth).send({ approvalQuorum: 0 }).expect(400);
    const other = await ctx.http().get('/api/organization').set(b.users.OWNER.auth).expect(200);
    expect(other.body.settings.approvalQuorum).toBe(3);
  });
});

describe('audit log viewer', () => {
  it('Owner/Admin see only their org’s events; others 403', async () => {
    const res = await ctx.http().get('/api/audit-log?limit=200').set(a.users.OWNER.auth).expect(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((i: { organizationId: string }) => i.organizationId === a.organizationId)).toBe(true);
    await ctx.http().get('/api/audit-log').set(a.users.EDITOR.auth).expect(403);
  });

  it('filters by action prefix', async () => {
    const res = await ctx.http().get('/api/audit-log?action=user.role').set(a.users.OWNER.auth).expect(200);
    expect(res.body.items.every((i: { action: string }) => i.action.startsWith('user.role'))).toBe(true);
  });
});

describe('organization deletion (§7.7)', () => {
  it('requires Owner, exact name and password; cancellable during cooldown', async () => {
    const t = await createTenant(ctx, 'doomed');
    const org = await ctx.prisma.organization.findUniqueOrThrow({ where: { id: t.organizationId } });
    await ctx.http().post('/api/organization/deletion').set(t.users.ADMIN.auth).send({ confirmName: org.name, password: TEST_PASSWORD }).expect(403);
    await ctx.http().post('/api/organization/deletion').set(t.users.OWNER.auth).send({ confirmName: 'wrong', password: TEST_PASSWORD }).expect(400);
    await ctx.http().post('/api/organization/deletion').set(t.users.OWNER.auth).send({ confirmName: org.name, password: 'nope' }).expect(401);
    const res = await ctx.http().post('/api/organization/deletion').set(t.users.OWNER.auth).send({ confirmName: org.name, password: TEST_PASSWORD }).expect(201);
    expect(res.body.status).toBe('pending_deletion');
    // still usable during cooldown so the Owner can cancel
    await ctx.http().get('/api/auth/me').set(t.users.EDITOR.auth).expect(200);
    const c = await ctx.http().delete('/api/organization/deletion').set(t.users.OWNER.auth).expect(200);
    expect(c.body.status).toBe('active');
    expect(await ctx.prisma.auditLog.count({ where: { organizationId: t.organizationId, action: { startsWith: 'org.deletion' } } })).toBe(2);
  });
});

describe('SSO stub', () => {
  it('lists no providers in MVP', async () => {
    const res = await ctx.http().get('/api/auth/sso/providers').expect(200);
    expect(res.body).toEqual([]);
  });
});
