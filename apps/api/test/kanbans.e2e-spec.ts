/** Phase 6 — Kanbans: CRUD, normalised ordering (§6.7), KanbanMedia, bulk import/edit/print, cross-tenant (§8). */
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

const create = (t: Tenant, body: object, role: 'EDITOR' | 'OPERATOR' = 'EDITOR') => ctx.http().post('/api/kanbans').set(as(t, role)).send(body);

describe('kanban CRUD', () => {
  it('Editor creates a card with picture and extra media; everyone can view; Operator cannot edit', async () => {
    const pic = await upload(a);
    const extra = await upload(a);
    const r = await create(a, {
      partCode: 'BRG-6204',
      partDescription: 'Ball bearing',
      supplier: 'SKF',
      location: 'Rack A3',
      price: 12.5,
      orderingType: 'email',
      orderingEmail: 'Buyer@Example.com',
      pictureAssetId: pic.body.id,
      mediaAssetIds: [extra.body.id],
      template: '02',
    }).expect(201);
    expect(r.body).toMatchObject({ partCode: 'BRG-6204', orderingType: 'email', orderingEmail: 'buyer@example.com', orderingUrl: null, price: 12.5 });
    expect(r.body.picture.url).toMatch(/X-Amz-Signature/);
    expect(r.body.media).toHaveLength(1);
    expect((await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: pic.body.id } })).lifecycleState).toBe('attached');

    await ctx.http().get(`/api/kanbans/${r.body.id}`).set(as(a, 'OPERATOR')).expect(200);
    await create(a, { partCode: 'X', orderingType: 'email', orderingEmail: 'a@b.co' }, 'OPERATOR').expect(403);
    await ctx.http().patch(`/api/kanbans/${r.body.id}`).set(as(a, 'OPERATOR')).send({ location: 'x' }).expect(403);
  });

  it('ordering target must match ordering_type (service validation, before the DB CHECK)', async () => {
    await create(a, { partCode: 'P1', orderingType: 'url' }).expect(400);
    await create(a, { partCode: 'P1', orderingType: 'url', orderingUrl: 'javascript:alert(1)' }).expect(400);
    await create(a, { partCode: 'P1', orderingType: 'email', orderingEmail: 'nope' }).expect(400);
    await create(a, { partCode: 'P1', orderingType: 'sop' }).expect(400);
    await create(a, { partCode: 'P1' }).expect(400);
    const ok = await create(a, { partCode: 'P1', orderingType: 'url', orderingUrl: 'https://shop.example.com/p1', orderingEmail: 'ignored@x.co' }).expect(201);
    expect(ok.body.orderingEmail).toBeNull();
  });

  it('switching ordering type clears the previous target', async () => {
    const { sopId } = await h.publishedSop(a, { name: 'Reorder procedure' });
    const k = await create(a, { partCode: 'SW-1', orderingType: 'url', orderingUrl: 'https://x.example.com' }).expect(201);
    const r = await ctx.http().patch(`/api/kanbans/${k.body.id}`).set(as(a, 'EDITOR')).send({ orderingType: 'sop', orderingSopId: sopId }).expect(200);
    expect(r.body).toMatchObject({ orderingType: 'sop', orderingUrl: null, orderingEmail: null, orderingSopId: sopId });
    expect(r.body.orderingSop.name).toBe('Reorder procedure');
  });

  it('list supports search, filters, sort and facets', async () => {
    await create(a, { partCode: 'ZZ-100', supplier: 'Bosch', tag: 'electrical', location: 'Bin 9', orderingType: 'email', orderingEmail: 'a@b.co' }).expect(201);
    await create(a, { partCode: 'AA-100', supplier: 'Bosch', tag: 'electrical', location: 'Bin 1', orderingType: 'email', orderingEmail: 'a@b.co' }).expect(201);
    const r = await ctx.http().get('/api/kanbans?supplier=Bosch&sort=partCode&dir=desc').set(as(a, 'OPERATOR')).expect(200);
    expect(r.body.items.map((k: { partCode: string }) => k.partCode)).toEqual(['ZZ-100', 'AA-100']);
    expect(r.body.facets.tags).toContain('electrical');
    const s = await ctx.http().get('/api/kanbans?search=zz-1').set(as(a, 'OPERATOR')).expect(200);
    expect(s.body.items.map((k: { partCode: string }) => k.partCode)).toEqual(['ZZ-100']);
    await ctx.http().get('/api/kanbans?sort=passwordHash').set(as(a, 'OPERATOR')).expect(400);
  });

  it('soft delete hides the card and orphans media only it used', async () => {
    const pic = await upload(a);
    const k = await create(a, { partCode: 'DEL-1', orderingType: 'email', orderingEmail: 'a@b.co', pictureAssetId: pic.body.id }).expect(201);
    await ctx.http().delete(`/api/kanbans/${k.body.id}`).set(as(a, 'EDITOR')).expect(204);
    await ctx.http().get(`/api/kanbans/${k.body.id}`).set(as(a, 'EDITOR')).expect(404);
    expect((await ctx.prisma.kanban.findUniqueOrThrow({ where: { id: k.body.id } })).deletedAt).not.toBeNull();
    expect((await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: pic.body.id } })).lifecycleState).toBe('orphaned');
  });
});

describe('bulk operations (role-gated)', () => {
  it('import is all-or-nothing and reports row errors', async () => {
    const bad = 'part_code,ordering_type,ordering_email,price\nOK-1,email,a@b.co,1.50\n,email,a@b.co,\nOK-2,email,not-an-email,\nOK-3,email,a@b.co,-4\n';
    const r1 = await ctx.http().post('/api/kanbans/bulk/import').set(as(a, 'EDITOR')).send({ csv: bad }).expect(200);
    expect(r1.body.imported).toBe(0);
    expect(r1.body.errors.map((e: { row: number }) => e.row)).toEqual([3, 4, 5]);
    expect(await ctx.prisma.kanban.count({ where: { organizationId: a.organizationId, partCode: 'OK-1' } })).toBe(0);
  });

  it('valid import creates every row (incl. SOP ordering by reference) and is audited', async () => {
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
    const r = await ctx.http().post('/api/kanbans/bulk/import').set(as(a, 'EDITOR')).send({ csv }).expect(200);
    expect(r.body.imported).toBe(3);
    const nut = await ctx.prisma.kanban.findFirstOrThrow({ where: { organizationId: a.organizationId, partCode: 'IMP-2' } });
    expect(nut.orderingSopId).toBe(sopId);
    const bolt = await ctx.prisma.kanban.findFirstOrThrow({ where: { organizationId: a.organizationId, partCode: 'IMP-1' } });
    expect(bolt.partDescription).toBe('Bolt, M8');
    expect(await ctx.prisma.auditLog.count({ where: { organizationId: a.organizationId, action: 'kanban.bulk.import' } })).toBe(1);
  });

  it('bulk edit updates many cards and is audited; operators are forbidden', async () => {
    const k1 = await create(a, { partCode: 'BE-1', orderingType: 'email', orderingEmail: 'a@b.co' }).expect(201);
    const k2 = await create(a, { partCode: 'BE-2', orderingType: 'email', orderingEmail: 'a@b.co' }).expect(201);
    await ctx.http().patch('/api/kanbans/bulk').set(as(a, 'OPERATOR')).send({ ids: [k1.body.id], patch: { tag: 'x' } }).expect(403);
    const r = await ctx.http().patch('/api/kanbans/bulk').set(as(a, 'EDITOR')).send({ ids: [k1.body.id, k2.body.id], patch: { tag: 'fasteners', location: 'Rack B' } }).expect(200);
    expect(r.body.updated).toBe(2);
    expect((await ctx.prisma.kanban.findUniqueOrThrow({ where: { id: k2.body.id } })).location).toBe('Rack B');
    expect(await ctx.prisma.auditLog.count({ where: { organizationId: a.organizationId, action: 'kanban.bulk.edit' } })).toBeGreaterThan(0);
  });

  it('export CSV round-trips headers and neutralises formula injection', async () => {
    await create(a, { partCode: '=HYPERLINK("x")', orderingType: 'email', orderingEmail: 'a@b.co' }).expect(201);
    const r = await ctx.http().get('/api/kanbans/export.csv').set(as(a, 'EDITOR')).expect(200);
    expect(r.text.split('\r\n')[0]).toMatch(/^part_code,part_description/);
    expect(r.text).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('bulk print renders a PDF', async () => {
    const pic = await upload(a);
    const k = await create(a, { partCode: 'PR-1', partDescription: '<b>not html</b>', orderingType: 'email', orderingEmail: 'a@b.co', pictureAssetId: pic.body.id, barcode: '12345', color: '#ff0000' }).expect(201);
    const r = await ctx
      .http()
      .post('/api/kanbans/bulk/print')
      .set(as(a, 'OPERATOR'))
      .send({ ids: [k.body.id] })
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(r.status).toBe(200);
    expect((r.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  }, 60_000);
});

describe('cross-tenant isolation — kanbans (§8 Phase 6)', () => {
  it('tenant B cannot read, edit, delete, bulk-edit, print, reference SOPs of, or attach media from tenant A', async () => {
    const k = await create(a, { partCode: 'SECRET-1', orderingType: 'email', orderingEmail: 'a@b.co' }).expect(201);
    const B = as(b, 'OWNER');
    await expectCrossTenantNotFound(() => ctx.http().get(`/api/kanbans/${k.body.id}`).set(B));
    await expectCrossTenantNotFound(() => ctx.http().patch(`/api/kanbans/${k.body.id}`).set(B).send({ location: 'pwned' }));
    await expectCrossTenantNotFound(() => ctx.http().delete(`/api/kanbans/${k.body.id}`).set(B));
    await expectCrossTenantNotFound(() => ctx.http().patch('/api/kanbans/bulk').set(B).send({ ids: [k.body.id], patch: { tag: 'pwned' } }));
    await expectCrossTenantNotFound(() => ctx.http().post('/api/kanbans/bulk/print').set(B).send({ ids: [k.body.id] }));
    const list = await ctx.http().get('/api/kanbans?limit=500').set(B).expect(200);
    expect(list.body.items.map((x: { id: string }) => x.id)).not.toContain(k.body.id);
    const exp = await ctx.http().get('/api/kanbans/export.csv').set(B).expect(200);
    expect(exp.text).not.toContain('SECRET-1');

    const { sopId } = await h.publishedSop(a, { name: 'A-only SOP' });
    await ctx.http().post('/api/kanbans').set(B).send({ partCode: 'x', orderingType: 'sop', orderingSopId: sopId }).expect(400);
    const aPic = await upload(a);
    await ctx.http().post('/api/kanbans').set(B).send({ partCode: 'x', orderingType: 'email', orderingEmail: 'a@b.co', pictureAssetId: aPic.body.id }).expect(400);
    const ref = (await ctx.prisma.sop.findUniqueOrThrow({ where: { id: sopId } })).referenceNo;
    const imp = await ctx.http().post('/api/kanbans/bulk/import').set(B).send({ csv: `part_code,ordering_type,ordering_sop_ref\nx,sop,${ref}\n` }).expect(200);
    expect(imp.body.imported).toBe(0);

    const untouched = await ctx.prisma.kanban.findUniqueOrThrow({ where: { id: k.body.id } });
    expect(untouched.location).toBeNull();
    expect(untouched.deletedAt).toBeNull();
  });
});
