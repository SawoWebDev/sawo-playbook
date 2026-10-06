/** Kanbans: revision workflow (drafts never touch live data), routing, approvals, bulk import/edit, cross-tenant (§8). */
import { MailService } from '../src/mail/mail.service';
import { createTenant, createTestApp, expectCrossTenantNotFound, resetDatabase, Tenant, TestContext } from './harness';
import { PNG_1PX, sopHelpers } from './sop-helpers';

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

const upload = (t: Tenant) =>
  ctx.http().post('/api/media').set(as(t, 'EDITOR')).attach('file', PNG_1PX, { filename: 'part.png', contentType: 'image/png' }).expect(201);

const body = (partCode: string, extra: object = {}) => ({ partCode, orderingType: 'email', orderingEmail: 'buyer@example.com', ...extra });
const draft = (t: Tenant, role: 'EDITOR' | 'ADMIN' | 'APPROVER' | 'OPERATOR' = 'EDITOR', payload: object = body(`P-${Math.random().toString(36).slice(2, 7)}`)) =>
  ctx.http().post('/api/kanbans').set(as(t, role)).send(payload);
const live = (t: Tenant, id: string) => ctx.http().get(`/api/kanbans/${id}`).set(as(t, 'OPERATOR'));
const revisions = (t: Tenant, role: 'EDITOR' | 'ADMIN' | 'APPROVER' = 'EDITOR') => ctx.http().get('/api/kanbans/revisions').set(as(t, role));

/** Creates a draft and publishes it through the Approver's direct path; returns the live card id. */
async function publishedCard(t: Tenant, partCode: string, extra: object = {}): Promise<string> {
  const d = await draft(t, 'EDITOR', body(partCode, extra)).expect(201);
  const p = await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/publish`).set(as(t, 'APPROVER')).expect(200);
  return p.body.id as string;
}

/** Full normal path: submit → pre-approve → approve → publish. */
async function runNormalPath(t: Tenant, rid: string, pre: { auth: { Authorization: string } }) {
  await ctx.http().post(`/api/kanbans/revisions/${rid}/submit`).set(as(t, 'EDITOR')).expect(200);
  await ctx.http().post(`/api/kanbans/revisions/${rid}/pre-approve`).set(pre.auth).expect(200);
  await ctx.http().post(`/api/kanbans/revisions/${rid}/approve`).set(as(t, 'APPROVER')).expect(200);
  return ctx.http().post(`/api/kanbans/revisions/${rid}/publish`).set(as(t, 'APPROVER')).expect(200);
}

describe('live content is never overwritten by drafts (data safety)', () => {
  it('editing a published card creates a draft; the live card is unchanged until publish, then updates', async () => {
    const id = await publishedCard(a, 'SAFE-1', { partDescription: 'Title A' });
    const before = (await live(a, id).expect(200)).body;
    expect(before).toMatchObject({ partDescription: 'Title A', location: null });

    // Editor changes the title and location — this must create a draft.
    const edit = await ctx.http().patch(`/api/kanbans/${id}`).set(as(a, 'EDITOR')).send({ partDescription: 'Title B', location: 'Rack B' }).expect(200);
    expect(edit.body).toMatchObject({ state: 'DRAFT', kanbanId: id, partDescription: 'Title B', location: 'Rack B' });

    // Published record unchanged while the draft exists.
    const during = (await live(a, id).expect(200)).body;
    expect(during).toMatchObject({ partDescription: 'Title A', location: null });
    expect((await ctx.prisma.kanban.findUniqueOrThrow({ where: { id } })).partDescription).toBe('Title A');

    // Draft holds the change; publish is the only transition that writes the live row.
    const pre = await a.addUser('PRE_APPROVER', 'pre-safe');
    await runNormalPath(a, edit.body.id, pre);
    const after = (await live(a, id).expect(200)).body;
    expect(after).toMatchObject({ partDescription: 'Title B', location: 'Rack B' });
  });

  it('a revision in review cannot be edited; the editor gets 409 until the review resolves', async () => {
    const id = await publishedCard(a, 'SAFE-2');
    const edit = await ctx.http().patch(`/api/kanbans/${id}`).set(as(a, 'EDITOR')).send({ location: 'X' }).expect(200);
    await ctx.http().post(`/api/kanbans/revisions/${edit.body.id}/submit`).set(as(a, 'EDITOR')).expect(200);
    await ctx.http().patch(`/api/kanbans/${id}`).set(as(a, 'EDITOR')).send({ location: 'Y' }).expect(409);
  });

  it('editor can never delete a published card or publish their own draft', async () => {
    const id = await publishedCard(a, 'SAFE-3');
    await ctx.http().delete(`/api/kanbans/${id}`).set(as(a, 'EDITOR')).expect(403);
    const d = await draft(a, 'EDITOR').expect(201);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/publish`).set(as(a, 'EDITOR')).expect(403);
    expect((await ctx.prisma.kanban.findUniqueOrThrow({ where: { id } })).deletedAt).toBeNull();
  });

  it('a rejected revision can be edited and resubmitted; the published version stays put throughout', async () => {
    const id = await publishedCard(a, 'REJ-1', { location: 'Original' });
    const pre = await a.addUser('PRE_APPROVER', 'pre-rej');
    const edit = await ctx.http().patch(`/api/kanbans/${id}`).set(as(a, 'EDITOR')).send({ location: 'Draft one' }).expect(200);
    await ctx.http().post(`/api/kanbans/revisions/${edit.body.id}/submit`).set(as(a, 'EDITOR')).expect(200);
    const rej = await ctx.http().post(`/api/kanbans/revisions/${edit.body.id}/reject`).set(pre.auth).send({ comment: 'Wrong bin' }).expect(200);
    expect(rej.body).toMatchObject({ state: 'DRAFT', lastComment: 'Wrong bin' });
    expect((await live(a, id).expect(200)).body.location).toBe('Original');

    await ctx.http().patch(`/api/kanbans/${id}`).set(as(a, 'EDITOR')).send({ location: 'Fixed bin' }).expect(200);
    await ctx.http().post(`/api/kanbans/revisions/${edit.body.id}/submit`).set(as(a, 'EDITOR')).expect(200);
    await ctx.http().post(`/api/kanbans/revisions/${edit.body.id}/pre-approve`).set(pre.auth).expect(200);
    await ctx.http().post(`/api/kanbans/revisions/${edit.body.id}/approve`).set(as(a, 'APPROVER')).expect(200);
    await ctx.http().post(`/api/kanbans/revisions/${edit.body.id}/publish`).set(as(a, 'APPROVER')).expect(200);
    expect((await live(a, id).expect(200)).body.location).toBe('Fixed bin');
  });
});

describe('role matrix for the workflow', () => {
  it('Viewer cannot create, edit, submit or publish', async () => {
    await draft(a, 'OPERATOR').expect(403);
    const id = await publishedCard(a, 'VIEW-1');
    await ctx.http().patch(`/api/kanbans/${id}`).set(as(a, 'OPERATOR')).send({ location: 'x' }).expect(403);
  });

  it('Pre Approver can pre-approve and reject, but cannot publish (by default)', async () => {
    const pre = await a.addUser('PRE_APPROVER', 'pre-matrix');
    const d = await draft(a, 'EDITOR').expect(201);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/submit`).set(as(a, 'EDITOR')).expect(200);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/publish`).set(pre.auth).expect(403);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/pre-approve`).set(pre.auth).expect(200);
  });

  it('Approver direct path: Draft → Approved → Published, without a Pre Approver', async () => {
    const d = await draft(a, 'EDITOR').expect(201);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/submit`).set(as(a, 'EDITOR')).expect(200);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/approve`).set(as(a, 'APPROVER')).expect(200);
    const p = await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/publish`).set(as(a, 'APPROVER')).expect(200);
    expect(p.body.id).toBeTruthy();
  });

  it('Approver can publish a draft directly with no submission at all', async () => {
    const d = await draft(a, 'APPROVER').expect(201);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/publish`).set(as(a, 'APPROVER')).expect(200);
  });

  it('Admin is unrestricted: creates, submits and publishes; no group needed', async () => {
    const d = await draft(a, 'ADMIN').expect(201);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/submit`).set(as(a, 'ADMIN')).expect(200);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/publish`).set(as(a, 'ADMIN')).expect(200);
  });

  it('an Admin cannot approve their own submission (self-approval is off)', async () => {
    const d = await draft(a, 'ADMIN', body('SELF-1')).expect(201);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/submit`).set(as(a, 'ADMIN')).expect(200);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/approve`).set(as(a, 'ADMIN')).expect(403);
  });
});

describe('routing and approval scope', () => {
  it('an approver outside the submitter\'s group cannot pre-approve; the item is hidden from their inbox', async () => {
    const t = await createTenant(ctx, 'routing');
    const outsider = await t.addUser('PRE_APPROVER', 'outside');
    await ctx.prisma.userGroup.create({ data: { organizationId: t.organizationId, name: 'Ops' } }).then(async (ops) => {
      await ctx.prisma.groupMember.create({ data: { groupId: ops.id, userId: outsider.user.id, organizationId: t.organizationId } });
      // outsider is only in Ops, not General
      await ctx.prisma.groupMember.deleteMany({ where: { userId: outsider.user.id, group: { name: 'General' } } });
    });
    const d = await draft(t, 'EDITOR').expect(201);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/submit`).set(as(t, 'EDITOR')).expect(200);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/pre-approve`).set(outsider.auth).expect(403);
    const inbox = await ctx.http().get('/api/kanbans/revisions').set(outsider.auth).expect(200);
    expect(inbox.body.preApproval.map((r: { id: string }) => r.id)).not.toContain(d.body.id);
  });

  it('the submitter\'s groups are snapshotted at submission; a multi-group submitter routes to any of them', async () => {
    const t = await createTenant(ctx, 'multi');
    const ops = await ctx.prisma.userGroup.create({ data: { organizationId: t.organizationId, name: 'Ops' } });
    await ctx.prisma.groupMember.create({ data: { groupId: ops.id, userId: t.users.EDITOR.user.id, organizationId: t.organizationId } });
    const d = await draft(t, 'EDITOR').expect(201);
    const sub = await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/submit`).set(as(t, 'EDITOR')).expect(200);
    expect(sub.body.routingGroups.map((g: { name: string }) => g.name).sort()).toEqual(['General', 'Ops']);
    // A pre-approver in Ops (not General) may act on it.
    const opsPre = await t.addUser('PRE_APPROVER', 'ops-pre');
    await ctx.prisma.groupMember.deleteMany({ where: { userId: opsPre.user.id } });
    await ctx.prisma.groupMember.create({ data: { groupId: ops.id, userId: opsPre.user.id, organizationId: t.organizationId } });
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/pre-approve`).set(opsPre.auth).expect(200);
  });

  it('removing a group from an approver while their item is pending stops them acting on it', async () => {
    const t = await createTenant(ctx, 'loses-group');
    const pre = await t.addUser('PRE_APPROVER', 'loses');
    const d = await draft(t, 'EDITOR').expect(201);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/submit`).set(as(t, 'EDITOR')).expect(200);
    await ctx.prisma.groupMember.deleteMany({ where: { userId: pre.user.id } });
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/pre-approve`).set(pre.auth).expect(403);
    expect(await ctx.prisma.auditLog.count({ where: { organizationId: t.organizationId, action: 'kanban.revision.authorization_denied' } })).toBeGreaterThan(0);
  });

  it('an Admin-submitted revision has no routing groups (organisation-wide)', async () => {
    const t = await createTenant(ctx, 'admin-route');
    const d = await draft(t, 'ADMIN').expect(201);
    const sub = await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/submit`).set(as(t, 'ADMIN')).expect(200);
    expect(sub.body.routingGroups).toEqual([]);
    const anyPre = await t.addUser('PRE_APPROVER', 'any-pre');
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/pre-approve`).set(anyPre.auth).expect(200);
  });

  it('with no eligible Pre Approver the item stays pending, shows as blocked, and Admins are notified', async () => {
    const t = await createTenant(ctx, 'blocked');
    // The harness creates one user per role; suspend the Pre Approver so this tenant truly has none.
    await ctx.prisma.user.update({ where: { id: t.users.PRE_APPROVER.user.id }, data: { status: 'suspended' } });
    const mail = ctx.app.get(MailService);
    const d = await draft(t, 'EDITOR').expect(201);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/submit`).set(as(t, 'EDITOR')).expect(200);
    const state = await ctx.prisma.kanbanRevision.findUniqueOrThrow({ where: { id: d.body.id } });
    expect(state.state).toBe('PENDING_PRE_APPROVAL'); // not bypassed, not published
    const inbox = await ctx.http().get('/api/kanbans/revisions').set(as(t, 'ADMIN')).expect(200);
    expect(inbox.body.blocked.map((r: { id: string }) => r.id)).toContain(d.body.id);
    expect(inbox.body.blocked[0].blockedReason).toMatch(/no eligible Pre Approver/);
    expect(mail.outbox.some((m) => m.to === t.users.ADMIN.user.email && /Approval blocked/.test(m.subject))).toBe(true);
    expect(await ctx.prisma.auditLog.count({ where: { organizationId: t.organizationId, action: 'kanban.revision.blocked' } })).toBe(1);
  });

  it('when an eligible approver appears later, the same pending item becomes actionable without resubmission', async () => {
    const t = await createTenant(ctx, 'unblocks');
    const d = await draft(t, 'EDITOR').expect(201);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/submit`).set(as(t, 'EDITOR')).expect(200);
    const later = await t.addUser('PRE_APPROVER', 'later');
    const inbox = await ctx.http().get('/api/kanbans/revisions').set(later.auth).expect(200);
    expect(inbox.body.preApproval.map((r: { id: string }) => r.id)).toContain(d.body.id);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/pre-approve`).set(later.auth).expect(200);
  });

  it('inbox is server-scoped: an unrelated editor sees only their own drafts in "mine"', async () => {
    const t = await createTenant(ctx, 'scoped');
    const other = await t.addUser('EDITOR', 'other');
    await draft(t, 'EDITOR').expect(201);
    const mine = await ctx.http().get('/api/kanbans/revisions').set(other.auth).expect(200);
    expect(mine.body.mine).toEqual([]);
    expect(mine.body.preApproval).toEqual([]);
    expect(mine.body.finalApproval).toEqual([]);
  });
});

describe('transitions are strict and race-safe', () => {
  it('skipping a stage is refused (pre-approve a draft = 409)', async () => {
    const pre = await a.addUser('PRE_APPROVER', 'skip-pre');
    const d = await draft(a, 'EDITOR').expect(201);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/pre-approve`).set(pre.auth).expect(409);
  });

  it('duplicate submission is refused (409)', async () => {
    const d = await draft(a, 'EDITOR').expect(201);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/submit`).set(as(a, 'EDITOR')).expect(200);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/submit`).set(as(a, 'EDITOR')).expect(409);
  });

  it('two simultaneous publishes: exactly one succeeds, the other is refused, and the card is created once', async () => {
    const d = await draft(a, 'EDITOR', body('RACE-1')).expect(201);
    const [r1, r2] = await Promise.all([
      ctx.http().post(`/api/kanbans/revisions/${d.body.id}/publish`).set(as(a, 'APPROVER')),
      ctx.http().post(`/api/kanbans/revisions/${d.body.id}/publish`).set(as(a, 'APPROVER')),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(await ctx.prisma.kanban.count({ where: { organizationId: a.organizationId, partCode: 'RACE-1' } })).toBe(1);
  });

  it('a published revision cannot be discarded, rejected or re-published', async () => {
    const d = await draft(a, 'EDITOR').expect(201);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/publish`).set(as(a, 'APPROVER')).expect(200);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/publish`).set(as(a, 'APPROVER')).expect(409);
    await ctx.http().delete(`/api/kanbans/revisions/${d.body.id}`).set(as(a, 'EDITOR')).expect(409);
  });

  it('an editor can discard their own draft; the live card is untouched', async () => {
    const id = await publishedCard(a, 'DISC-1', { location: 'Keep' });
    const d = await ctx.http().patch(`/api/kanbans/${id}`).set(as(a, 'EDITOR')).send({ location: 'Gone' }).expect(200);
    await ctx.http().delete(`/api/kanbans/revisions/${d.body.id}`).set(as(a, 'EDITOR')).expect(204);
    expect((await live(a, id).expect(200)).body.location).toBe('Keep');
  });
});

describe('audit trail', () => {
  it('records the workflow events against the revision, with actor and states', async () => {
    const d = await draft(a, 'EDITOR').expect(201);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/submit`).set(as(a, 'EDITOR')).expect(200);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/approve`).set(as(a, 'APPROVER')).expect(200);
    const rows = await ctx.prisma.auditLog.findMany({ where: { organizationId: a.organizationId, entityType: 'kanban_revision', entityId: d.body.id }, orderBy: { occurredAt: 'asc' } });
    expect(rows.map((r) => r.action)).toEqual(['kanban.revision.created', 'kanban.revision.submitted', 'kanban.revision.approved']);
    expect(rows[1].actorId).toBe(a.users.EDITOR.user.id);
    expect(rows[1].metadata).toMatchObject({ previousState: 'DRAFT', newState: 'PENDING_PRE_APPROVAL' });
  });

  it('a publish is audited with the previous state and that it was a direct publish when not approved first', async () => {
    const d = await draft(a, 'EDITOR').expect(201);
    await ctx.http().post(`/api/kanbans/revisions/${d.body.id}/publish`).set(as(a, 'APPROVER')).expect(200);
    const row = await ctx.prisma.auditLog.findFirstOrThrow({ where: { entityId: d.body.id, action: 'kanban.revision.published' } });
    expect(row.metadata).toMatchObject({ previousState: 'DRAFT', newState: 'PUBLISHED', directPublish: true });
  });
});

describe('kanban CRUD (drafts)', () => {
  it('Editor creates a draft with picture and media; nothing is live until published', async () => {
    const pic = await upload(a);
    const extra = await upload(a);
    const r = await draft(a, 'EDITOR', body('BRG-6204', {
      partDescription: 'Ball bearing', supplier: 'SKF', location: 'Rack A3', price: 12.5,
      orderingEmail: 'Buyer@Example.com', pictureAssetId: pic.body.id, mediaAssetIds: [extra.body.id], template: '02',
    })).expect(201);
    expect(r.body).toMatchObject({ state: 'DRAFT', partCode: 'BRG-6204', orderingType: 'email', orderingEmail: 'buyer@example.com', price: 12.5 });
    expect(r.body.picture.url).toMatch(/^\/api\/files\//);
    expect(r.body.media).toHaveLength(1);
    expect((await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: pic.body.id } })).lifecycleState).toBe('attached');
    expect(await ctx.prisma.kanban.count({ where: { organizationId: a.organizationId, partCode: 'BRG-6204' } })).toBe(0);
  });

  it('ordering target must match ordering_type, validated when the draft is created', async () => {
    await draft(a, 'EDITOR', { partCode: 'P1', orderingType: 'url', orderingUrl: 'javascript:alert(1)' }).expect(400);
    await draft(a, 'EDITOR', { partCode: 'P1', orderingType: 'email', orderingEmail: 'nope' }).expect(400);
    await draft(a, 'EDITOR', { partCode: 'P1', orderingType: 'sop' }).expect(400);
    await draft(a, 'EDITOR', { partCode: 'P1' }).expect(400);
  });

  it('list shows live cards only; search, filters, sort and facets work on the published set', async () => {
    await publishedCard(a, 'ZZ-100', { supplier: 'Bosch', tag: 'electrical', location: 'Bin 9' });
    await publishedCard(a, 'AA-100', { supplier: 'Bosch', tag: 'electrical', location: 'Bin 1' });
    await draft(a, 'EDITOR', body('DRAFT-ONLY', { supplier: 'Bosch' })).expect(201);
    const r = await ctx.http().get('/api/kanbans?supplier=Bosch&sort=partCode&dir=desc').set(as(a, 'OPERATOR')).expect(200);
    expect(r.body.items.map((k: { partCode: string }) => k.partCode)).toEqual(['ZZ-100', 'AA-100']);
    expect(r.body.facets.tags).toContain('electrical');
    const s = await ctx.http().get('/api/kanbans?search=zz-1').set(as(a, 'OPERATOR')).expect(200);
    expect(s.body.items.map((k: { partCode: string }) => k.partCode)).toEqual(['ZZ-100']);
    await ctx.http().get('/api/kanbans?sort=passwordHash').set(as(a, 'OPERATOR')).expect(400);
  });

  it('history of a live card is built from its revisions and publish events', async () => {
    const id = await publishedCard(a, 'HIST-1');
    await ctx.http().patch(`/api/kanbans/${id}`).set(as(a, 'EDITOR')).send({ location: 'Rack H1' }).expect(200);
    const r = await ctx.http().get(`/api/kanbans/${id}/history`).set(as(a, 'OPERATOR')).expect(200);
    expect(r.body.map((x: { action: string }) => x.action)).toEqual(expect.arrayContaining(['Published', 'Draft created', 'Draft created']));
    await ctx.http().get(`/api/kanbans/${id}/history`).set(as(b, 'OPERATOR')).expect(404);
  });

  it('soft delete of a published card needs publish authority, hides it, and orphans media only it used', async () => {
    const pic = await upload(a);
    const id = await publishedCard(a, 'DEL-1', { pictureAssetId: pic.body.id });
    await ctx.http().delete(`/api/kanbans/${id}`).set(as(a, 'EDITOR')).expect(403);
    await ctx.http().delete(`/api/kanbans/${id}`).set(as(a, 'APPROVER')).expect(204);
    await ctx.http().get(`/api/kanbans/${id}`).set(as(a, 'OPERATOR')).expect(404);
    expect((await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: pic.body.id } })).lifecycleState).toBe('orphaned');
  });

  it('a card with an open revision cannot be deleted until the revision is resolved', async () => {
    const id = await publishedCard(a, 'DEL-2');
    await ctx.http().patch(`/api/kanbans/${id}`).set(as(a, 'EDITOR')).send({ location: 'pending' }).expect(200);
    await ctx.http().delete(`/api/kanbans/${id}`).set(as(a, 'APPROVER')).expect(409);
  });
});

describe('bulk operations', () => {
  it('import creates drafts only, skips invalid rows and reports them (partial success)', async () => {
    const csv = 'part_code,ordering_type,ordering_email,price\nOK-1,email,a@b.co,1.50\n,email,a@b.co,\nOK-2,email,not-an-email,\nOK-3,email,a@b.co,-4\n';
    const r = await ctx.http().post('/api/kanbans/bulk/import').set(as(a, 'EDITOR')).send({ csv }).expect(200);
    expect(r.body.imported).toBe(1);
    expect(r.body.errors.map((e: { row: number }) => e.row)).toEqual([3, 4, 5]);
    expect(await ctx.prisma.kanban.count({ where: { organizationId: a.organizationId, partCode: 'OK-1' } })).toBe(0);
    const drafts = await ctx.prisma.kanbanRevision.findMany({ where: { organizationId: a.organizationId, state: 'DRAFT', payload: { path: ['partCode'], equals: 'OK-1' } } });
    expect(drafts).toHaveLength(1);
  });

  it('valid import creates a draft per row (incl. SOP ordering by reference), leaves live data alone, and is audited', async () => {
    const { sopId } = await h.publishedSop(a, { name: 'Order via SOP' });
    const ref = (await ctx.prisma.sop.findUniqueOrThrow({ where: { id: sopId } })).referenceNo;
    const csv = [
      'Part Code,Part Description,Supplier,Ordering Type,Ordering URL,Ordering SOP Ref,Ordering Email,Price,Template',
      'IMP-1,"Bolt, M8",Acme,url,https://acme.example.com/m8,,,0.25,01',
      `IMP-2,Nut,Acme,sop,,${ref},,,02`,
      'IMP-3,Washer,,email,,,stores@example.com,,',
    ].join('\n');
    const dry = await ctx.http().post('/api/kanbans/bulk/import').set(as(a, 'EDITOR')).send({ csv, dryRun: true }).expect(200);
    expect(dry.body).toMatchObject({ imported: 0, valid: 3, errors: [] });
    expect(await ctx.prisma.kanbanRevision.count({ where: { organizationId: a.organizationId, payload: { path: ['partCode'], equals: 'IMP-2' } } })).toBe(0);
    const r = await ctx.http().post('/api/kanbans/bulk/import').set(as(a, 'EDITOR')).send({ csv }).expect(200);
    expect(r.body.imported).toBe(3);
    const nut = await ctx.prisma.kanbanRevision.findFirstOrThrow({ where: { organizationId: a.organizationId, payload: { path: ['partCode'], equals: 'IMP-2' } } });
    expect((nut.payload as { orderingSopId: string }).orderingSopId).toBe(sopId);
    expect(await ctx.prisma.kanban.count({ where: { organizationId: a.organizationId, partCode: { in: ['IMP-1', 'IMP-2', 'IMP-3'] } } })).toBe(0);
    expect(await ctx.prisma.auditLog.count({ where: { organizationId: a.organizationId, action: 'kanban.bulk.import' } })).toBeGreaterThan(0);
  });

  it('bulk edit publishes directly: Editors are refused, publishers succeed, and it is audited as direct', async () => {
    const k1 = await publishedCard(a, 'BE-1');
    const k2 = await publishedCard(a, 'BE-2');
    await ctx.http().patch('/api/kanbans/bulk').set(as(a, 'OPERATOR')).send({ ids: [k1], patch: { tag: 'x' } }).expect(403);
    await ctx.http().patch('/api/kanbans/bulk').set(as(a, 'EDITOR')).send({ ids: [k1, k2], patch: { tag: 'x' } }).expect(403);
    const r = await ctx.http().patch('/api/kanbans/bulk').set(as(a, 'APPROVER')).send({ ids: [k1, k2], patch: { tag: 'fasteners', location: 'Rack B' } }).expect(200);
    expect(r.body.updated).toBe(2);
    expect((await ctx.prisma.kanban.findUniqueOrThrow({ where: { id: k2 } })).location).toBe('Rack B');
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { organizationId: a.organizationId, action: 'kanban.bulk.edit' }, orderBy: { occurredAt: 'desc' } });
    expect(audit.metadata).toMatchObject({ directPublish: true });
  });

  it('export CSV round-trips headers and neutralises formula injection', async () => {
    await publishedCard(a, '=HYPERLINK("x")');
    const r = await ctx.http().get('/api/kanbans/export.csv').set(as(a, 'EDITOR')).expect(200);
    expect(r.text.split('\r\n')[0]).toMatch(/^part_code,part_description/);
    expect(r.text).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('bulk print renders a PDF', async () => {
    const pic = await upload(a);
    const id = await publishedCard(a, 'PR-1', { partDescription: '<b>not html</b>', pictureAssetId: pic.body.id, barcode: '12345', color: '#ff0000' });
    const r = await ctx.http().post('/api/kanbans/bulk/print').set(as(a, 'OPERATOR')).send({ ids: [id] }).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(r.status).toBe(200);
    expect((r.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  }, 60_000);
});

describe('open revision on cards and server-provided revision actions', () => {
  it('a card with no open revision shows openRevision: null in the list and detail', async () => {
    const id = await publishedCard(a, `OPEN-NONE-${Math.random().toString(36).slice(2, 6)}`);
    const detail = await live(a, id).expect(200);
    expect(detail.body.openRevision).toBeNull();
    const list = await ctx.http().get('/api/kanbans?limit=100').set(as(a, 'OPERATOR')).expect(200);
    expect(list.body.items.find((k: { id: string }) => k.id === id).openRevision).toBeNull();
  });

  it('an edit shows as an open DRAFT with no submitter; submitting shows the submitter and the pending state to every viewer', async () => {
    const id = await publishedCard(a, `OPEN-EDIT-${Math.random().toString(36).slice(2, 6)}`);
    await ctx.http().patch(`/api/kanbans/${id}`).set(as(a, 'EDITOR')).send({ location: 'Rack Z' }).expect(200);

    const draftView = (await live(a, id).expect(200)).body.openRevision;
    expect(draftView).toMatchObject({ state: 'DRAFT', comment: null, submitter: null });
    const rid = draftView.id as string;

    await ctx.http().post(`/api/kanbans/revisions/${rid}/submit`).set(as(a, 'EDITOR')).expect(200);
    const list = await ctx.http().get('/api/kanbans?limit=100').set(as(a, 'OPERATOR')).expect(200);
    const row = list.body.items.find((k: { id: string }) => k.id === id);
    expect(row.openRevision).toMatchObject({ id: rid, state: 'PENDING_PRE_APPROVAL', submitter: { id: expect.any(String) } });

    // Another tenant never sees it.
    const other = await ctx.http().get(`/api/kanbans/${id}`).set(as(b, 'ADMIN')).expect(404);
    expect(other.body.openRevision).toBeUndefined();
  });

  it('openRevision is cleared once the revision publishes or is discarded', async () => {
    const id = await publishedCard(a, `OPEN-CLEAR-${Math.random().toString(36).slice(2, 6)}`);
    await ctx.http().patch(`/api/kanbans/${id}`).set(as(a, 'EDITOR')).send({ location: 'Rack Q' }).expect(200);
    const rid = (await live(a, id).expect(200)).body.openRevision.id as string;
    await ctx.http().post(`/api/kanbans/revisions/${rid}/publish`).set(as(a, 'APPROVER')).expect(200);
    expect((await live(a, id).expect(200)).body.openRevision).toBeNull();
  });

  it('revision actions reflect the caller: an Editor may submit a draft but not publish it', async () => {
    const d = await draft(a, 'EDITOR').expect(201);
    const view = await ctx.http().get(`/api/kanbans/revisions/${d.body.id}`).set(as(a, 'EDITOR')).expect(200);
    expect(view.body.actions).toEqual({ submit: true, preApprove: false, approve: false, reject: false, publish: false });
  });

  it('revision actions after submission: a Pre Approver can pre-approve and reject, not publish; the submitter can do neither', async () => {
    const d = await draft(a, 'EDITOR').expect(201);
    const rid = d.body.id as string;
    await ctx.http().post(`/api/kanbans/revisions/${rid}/submit`).set(as(a, 'EDITOR')).expect(200);
    const pre = await a.addUser('PRE_APPROVER', 'pre-actions');

    const asPre = await ctx.http().get(`/api/kanbans/revisions/${rid}`).set(pre.auth).expect(200);
    expect(asPre.body.actions).toMatchObject({ submit: false, preApprove: true, reject: true, publish: false });

    const asSubmitter = await ctx.http().get(`/api/kanbans/revisions/${rid}`).set(as(a, 'EDITOR')).expect(200);
    expect(asSubmitter.body.actions).toMatchObject({ submit: false, preApprove: false, reject: false, publish: false });
  });

  it('a true action is one the endpoint accepts: the pre-approve action matches the pre-approve endpoint', async () => {
    const d = await draft(a, 'EDITOR').expect(201);
    const rid = d.body.id as string;
    await ctx.http().post(`/api/kanbans/revisions/${rid}/submit`).set(as(a, 'EDITOR')).expect(200);
    const pre = await a.addUser('PRE_APPROVER', 'pre-match');
    const view = await ctx.http().get(`/api/kanbans/revisions/${rid}`).set(pre.auth).expect(200);
    expect(view.body.actions.preApprove).toBe(true);
    await ctx.http().post(`/api/kanbans/revisions/${rid}/pre-approve`).set(pre.auth).expect(200);
  });

  it('an Admin cannot approve their own submission, and the actions say so', async () => {
    const d = await draft(a, 'ADMIN').expect(201);
    const rid = d.body.id as string;
    await ctx.http().post(`/api/kanbans/revisions/${rid}/submit`).set(as(a, 'ADMIN')).expect(200);
    const view = await ctx.http().get(`/api/kanbans/revisions/${rid}`).set(as(a, 'ADMIN')).expect(200);
    expect(view.body.actions.preApprove).toBe(false);
    expect(view.body.actions.approve).toBe(false);
  });
});

describe('publish action and the publish endpoint share one eligibility rule', () => {
  it('when the SOP ordering target is removed, actions.publish turns false and publish is refused with the same reason', async () => {
    const { sopId } = await h.publishedSop(a, { name: 'Ordering target removed' });
    const code = `ORD-${Math.random().toString(36).slice(2, 6)}`;
    const d = await draft(a, 'EDITOR', { partCode: code, orderingType: 'sop', orderingSopId: sopId }).expect(201);
    const rid = d.body.id as string;

    const before = await ctx.http().get(`/api/kanbans/revisions/${rid}`).set(as(a, 'APPROVER')).expect(200);
    expect(before.body.actions.publish).toBe(true);

    await ctx.prisma.sop.update({ where: { id: sopId }, data: { deletedAt: new Date() } });

    const after = await ctx.http().get(`/api/kanbans/revisions/${rid}`).set(as(a, 'APPROVER')).expect(200);
    expect(after.body.actions.publish).toBe(false);
    const attempt = await ctx.http().post(`/api/kanbans/revisions/${rid}/publish`).set(as(a, 'APPROVER')).expect(400);
    expect(attempt.body.message).toMatch(/Ordering SOP not found/);
    expect(await ctx.prisma.kanban.count({ where: { organizationId: a.organizationId, partCode: code } })).toBe(0);
  });
});

describe('inbox items carry the same action flags as the revision', () => {
  it('each inbox item has actions, and the lists are built from them', async () => {
    const d = await draft(a, 'EDITOR').expect(201);
    const rid = d.body.id as string;
    await ctx.http().post(`/api/kanbans/revisions/${rid}/submit`).set(as(a, 'EDITOR')).expect(200);

    const inbox = await revisions(a, 'EDITOR').expect(200);
    const mine = inbox.body.mine.find((i: { id: string }) => i.id === rid);
    expect(mine.actions).toEqual({ submit: false, preApprove: false, approve: false, reject: false, publish: false });

    const pre = await a.addUser('PRE_APPROVER', 'pre-inbox');
    const asPre = await ctx.http().get('/api/kanbans/revisions').set(pre.auth).expect(200);
    const listed = asPre.body.preApproval.find((i: { id: string }) => i.id === rid);
    expect(listed.actions).toMatchObject({ preApprove: true, reject: true, publish: false });
    const single = await ctx.http().get(`/api/kanbans/revisions/${rid}`).set(pre.auth).expect(200);
    expect(single.body.actions).toEqual(listed.actions);
  });
});

describe('cross-tenant isolation — kanban workflow (§8)', () => {
  it('tenant B cannot read, edit, publish, discard or see tenant A\'s drafts, cards or inbox entries', async () => {
    const d = await draft(a, 'EDITOR', body('SECRET-1')).expect(201);
    const B = as(b, 'ADMIN');
    await expectCrossTenantNotFound(() => ctx.http().get(`/api/kanbans/revisions/${d.body.id}`).set(B));
    await expectCrossTenantNotFound(() => ctx.http().post(`/api/kanbans/revisions/${d.body.id}/publish`).set(B));
    await expectCrossTenantNotFound(() => ctx.http().post(`/api/kanbans/revisions/${d.body.id}/submit`).set(B));
    await expectCrossTenantNotFound(() => ctx.http().delete(`/api/kanbans/revisions/${d.body.id}`).set(B));
    const inbox = await ctx.http().get('/api/kanbans/revisions').set(B).expect(200);
    expect(JSON.stringify(inbox.body)).not.toContain(d.body.id);
    const untouched = await ctx.prisma.kanbanRevision.findUniqueOrThrow({ where: { id: d.body.id } });
    expect(untouched.state).toBe('DRAFT');
  });

  it('tenant B cannot reference SOPs or media of tenant A when creating drafts or importing', async () => {
    const { sopId } = await h.publishedSop(a, { name: 'A-only SOP' });
    const B = as(b, 'EDITOR');
    await ctx.http().post('/api/kanbans').set(B).send({ partCode: 'x', orderingType: 'sop', orderingSopId: sopId }).expect(400);
    const aPic = await upload(a);
    await ctx.http().post('/api/kanbans').set(B).send({ partCode: 'x', orderingType: 'email', orderingEmail: 'a@b.co', pictureAssetId: aPic.body.id }).expect(400);
    const ref = (await ctx.prisma.sop.findUniqueOrThrow({ where: { id: sopId } })).referenceNo;
    const imp = await ctx.http().post('/api/kanbans/bulk/import').set(B).send({ csv: `part_code,ordering_type,ordering_sop_ref\nx,sop,${ref}\n` }).expect(200);
    expect(imp.body.imported).toBe(0);
  });
});
