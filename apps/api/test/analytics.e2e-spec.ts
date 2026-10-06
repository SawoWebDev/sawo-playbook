/** Phase 8 — ActivityEvent emission, analytics aggregation, PostgreSQL FTS (§4.6, §6.9, §14). */
import { toPrefixQuery } from '../src/analytics/search.service';
import { createTenant, createTestApp, resetDatabase, Tenant, TestContext } from './harness';
import { sopHelpers } from './sop-helpers';

let ctx: TestContext;
let a: Tenant;
let b: Tenant;
const h = sopHelpers(() => ctx);
const as = h.as;

beforeAll(async () => {
  ctx = await createTestApp();
  await resetDatabase(ctx.prisma);
  a = await createTenant(ctx, 'alpha');
  b = await createTenant(ctx, 'beta');
});
afterAll(() => ctx.close());

describe('ActivityEvent emission', () => {
  it('write and view paths emit events with actor and entity; ActivityEvent is append-only', async () => {
    const { sopId, versionId } = await h.publishedSop(a, { name: 'Tracked SOP' });
    await ctx.http().get(`/api/sops/${sopId}/current`).set(as(a, 'OPERATOR')).expect(200);
    const events = await ctx.prisma.activityEvent.findMany({ where: { organizationId: a.organizationId, entityId: sopId } });
    const types = events.map((e) => e.eventType);
    expect(types).toEqual(expect.arrayContaining(['sop.created', 'sop.edited', 'sop.version.submitted', 'sop.version.decided', 'sop.version.published', 'sop.viewed']));
    const view = events.find((e) => e.eventType === 'sop.viewed' && e.actorId === a.users.OPERATOR.user.id);
    expect(view).toBeDefined();
    const edit = events.find((e) => e.eventType === 'sop.edited')!;
    expect(edit.metadata).toMatchObject({ vid: versionId });
    await expect(ctx.prisma.activityEvent.update({ where: { id: edit.id }, data: { eventType: 'x' } })).rejects.toThrow(/immutable/);
  });

  it('failed requests emit nothing', async () => {
    const before = await ctx.prisma.activityEvent.count({ where: { organizationId: a.organizationId, eventType: 'sop.created' } });
    await ctx.http().post('/api/sops').set(as(a, 'OPERATOR')).send({ name: 'x' }).expect(403);
    await ctx.http().post('/api/sops').set(as(a, 'EDITOR')).send({}).expect(400);
    expect(await ctx.prisma.activityEvent.count({ where: { organizationId: a.organizationId, eventType: 'sop.created' } })).toBe(before);
  });

  it('login is recorded in both AuditLog and ActivityEvent', async () => {
    await ctx.http().post('/api/auth/login').send({ email: a.users.EDITOR.user.email, password: 'correct-horse-battery-staple' }).expect(200);
    expect(await ctx.prisma.activityEvent.count({ where: { eventType: 'user.login', actorId: a.users.EDITOR.user.id } })).toBe(1);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'auth.login.success', actorId: a.users.EDITOR.user.id } })).toBe(1);
  });
});

describe('analytics summary', () => {
  it('Owner/Admin see org-wide figures; Editor only their own; others 403', async () => {
    const org = await ctx.http().get('/api/analytics/summary').set(as(a, 'ADMIN')).expect(200);
    expect(org.body.scope).toBe('organization');
    expect(org.body.events.find((e: { eventType: string }) => e.eventType === 'sop.viewed').count).toBeGreaterThan(0);
    expect(org.body.topSops[0].sop.name).toBe('Tracked SOP');
    expect(org.body.topActors.length).toBeGreaterThan(0);
    expect(org.body.totals.sopsByStatus.published).toBeGreaterThanOrEqual(1);

    const ed = await ctx.http().get('/api/analytics/summary').set(as(a, 'EDITOR')).expect(200);
    expect(ed.body.scope).toBe('own');
    expect(ed.body.topActors).toEqual([]);
    expect(ed.body.totals.activeUsers).toBeNull();
    const edEvents = await ctx.prisma.activityEvent.count({ where: { organizationId: a.organizationId, actorId: a.users.EDITOR.user.id } });
    const sum = ed.body.events.reduce((n: number, e: { count: number }) => n + e.count, 0);
    expect(sum).toBe(edEvents);

    await ctx.http().get('/api/analytics/summary').set(as(a, 'APPROVER')).expect(403); // analytics is not part of approval
    await ctx.http().get('/api/analytics/summary').set(as(a, 'OPERATOR')).expect(403);
    await ctx.http().get('/api/analytics/summary?from=2026-01-01&to=2025-01-01').set(as(a, 'ADMIN')).expect(400);
  });

  it('cross-tenant: another org’s analytics never include these events', async () => {
    const r = await ctx.http().get('/api/analytics/summary').set(as(b, 'OWNER')).expect(200);
    expect(r.body.topSops).toEqual([]);
    expect(r.body.events.find((e: { eventType: string }) => e.eventType === 'sop.viewed')).toBeUndefined();
  });
});

describe('full-text search (§14)', () => {
  let publishedId: string;
  let draftOnlyId: string;

  beforeAll(async () => {
    const f = await ctx.http().post('/api/folders').set(as(a, 'EDITOR')).send({ name: 'Hydraulics' }).expect(201);
    const p = await h.createSop(a, 'Pump overhaul');
    await ctx.http().patch(`/api/sops/${p.sopId}`).set(as(a, 'EDITOR')).send({ folderId: f.body.id }).expect(200);
    await h.saveSteps(a, p.sopId, p.versionId, [{ title: 'Drain', description: '<p>Release <b>accumulator</b> pressure slowly</p>' }]);
    await h.publishFlow(a, p.sopId, p.versionId);
    publishedId = p.sopId;
    // new draft with extra content that must not be visible to operators
    const d = await ctx.http().post(`/api/sops/${p.sopId}/versions`).set(as(a, 'EDITOR')).expect(201);
    await h.saveSteps(a, p.sopId, d.body.id, [{ description: 'Replace impeller gasket' }]);

    const draft = await h.createSop(a, 'Secret draft procedure');
    await h.saveSteps(a, draft.sopId, draft.versionId, [{ description: 'Confidential zeppelin step' }]);
    draftOnlyId = draft.sopId;

    const hyd = await ctx.http().post('/api/kanbans').set(as(a, 'EDITOR')).send({ partCode: 'HYD-SEAL-42', partDescription: 'Piston seal kit', supplier: 'Parker', tag: 'hydraulic', orderingType: 'email', orderingEmail: 'a@b.co' }).expect(201);
    await ctx.http().post(`/api/kanbans/revisions/${hyd.body.id}/publish`).set(as(a, 'APPROVER')).expect(200); // live only once published
  });

  const search = (role: 'OPERATOR' | 'EDITOR', q: string, t = a) => ctx.http().get(`/api/search?q=${encodeURIComponent(q)}`).set(as(t, role)).expect(200);

  it('builds safe prefix queries', () => {
    expect(toPrefixQuery("brg-62 'drop table")).toBe('brg:* & 62:* & drop:* & table:*');
    expect(toPrefixQuery('  !!! ')).toBeNull();
  });

  it('matches published step content (HTML stripped), titles, names, reference and folder name', async () => {
    for (const q of ['accumulator', 'drain', 'pump overhaul', 'hydraul', 'accum press']) {
      const r = await search('OPERATOR', q);
      expect(r.body.sops.map((s: { id: string }) => s.id)).toContain(publishedId);
    }
    const ref = (await ctx.prisma.sop.findUniqueOrThrow({ where: { id: publishedId } })).referenceNo;
    expect((await search('OPERATOR', ref)).body.sops[0].id).toBe(publishedId);
  });

  it('draft content is searchable by every role — Viewers see drafts too (read-only)', async () => {
    for (const role of ['EDITOR', 'OPERATOR'] as const) {
      const r = await search(role, 'impeller');
      expect(r.body.sops[0]).toMatchObject({ id: publishedId, matchedIn: ['draft content'] });
      expect((await search(role, 'zeppelin')).body.sops.map((s: { id: string }) => s.id)).toEqual([draftOnlyId]);
    }
  });

  it('folder rename is reflected synchronously', async () => {
    const f = await ctx.prisma.folder.findFirstOrThrow({ where: { organizationId: a.organizationId, name: 'Hydraulics' } });
    await ctx.http().patch(`/api/folders/${f.id}`).set(as(a, 'EDITOR')).send({ name: 'Fluid power' }).expect(200);
    expect((await search('OPERATOR', 'fluid')).body.sops.map((s: { id: string }) => s.id)).toContain(publishedId);
    expect((await search('OPERATOR', 'hydraulics')).body.sops.map((s: { id: string }) => s.id)).not.toContain(publishedId);
  });

  it('finds kanbans by code prefix, description, supplier and tag; excludes soft-deleted', async () => {
    for (const q of ['hyd-seal', 'piston', 'parker', 'hydraulic']) {
      expect((await search('OPERATOR', q)).body.kanbans.map((k: { partCode: string }) => k.partCode)).toContain('HYD-SEAL-42');
    }
    const k = await ctx.prisma.kanban.findFirstOrThrow({ where: { organizationId: a.organizationId, partCode: 'HYD-SEAL-42' } });
    await ctx.http().delete(`/api/kanbans/${k.id}`).set(as(a, 'APPROVER')).expect(204);
    expect((await search('OPERATOR', 'piston')).body.kanbans).toEqual([]);
  });

  it('cross-tenant: other orgs never see these results', async () => {
    const r = await search('EDITOR', 'accumulator', b);
    expect(r.body.sops).toEqual([]);
    expect((await search('EDITOR', 'zeppelin', b)).body.sops).toEqual([]);
  });
});
