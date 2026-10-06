/** Phase 5 — folders: tree CRUD, cycle prevention, filtering, soft delete, cross-tenant. */
import { createTenant, createTestApp, expectCrossTenantNotFound, resetDatabase, Tenant, TestContext } from './harness';
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

const mk = (t: Tenant, name: string, parentId?: string) =>
  ctx.http().post('/api/folders').set(as(t, 'EDITOR')).send({ name, parentId });

describe('folders', () => {
  it('Editor+ creates a tree; Operator and Approver cannot', async () => {
    const root = await mk(a, 'Assembly').expect(201);
    const child = await mk(a, 'Line 1', root.body.id).expect(201);
    expect(child.body.parentId).toBe(root.body.id);
    await ctx.http().post('/api/folders').set(as(a, 'OPERATOR')).send({ name: 'x' }).expect(403);
    await ctx.http().post('/api/folders').set(as(a, 'APPROVER')).send({ name: 'Approver folder' }).expect(403); // folder management is not part of approval
    const list = await ctx.http().get('/api/folders').set(as(a, 'OPERATOR')).expect(200);
    expect(list.body.map((f: { name: string }) => f.name)).toEqual(expect.arrayContaining(['Assembly', 'Line 1']));
  });

  it('sibling names are unique (case-insensitive)', async () => {
    const p = await mk(a, 'Parent').expect(201);
    await mk(a, 'Welding', p.body.id).expect(201);
    await mk(a, 'welding', p.body.id).expect(409);
    await mk(a, 'Welding').expect(201); // different parent (root) is fine
  });

  it('prevents cycles when moving', async () => {
    const x = await mk(a, 'X').expect(201);
    const y = await mk(a, 'Y', x.body.id).expect(201);
    const z = await mk(a, 'Z', y.body.id).expect(201);
    await ctx.http().patch(`/api/folders/${x.body.id}`).set(as(a, 'EDITOR')).send({ parentId: z.body.id }).expect(400);
    await ctx.http().patch(`/api/folders/${x.body.id}`).set(as(a, 'EDITOR')).send({ parentId: x.body.id }).expect(400);
    const moved = await ctx.http().patch(`/api/folders/${z.body.id}`).set(as(a, 'EDITOR')).send({ parentId: null }).expect(200);
    expect(moved.body.parentId).toBeNull();
  });

  it('filters SOPs by folder, optionally including subfolders; counts SOPs', async () => {
    const top = await mk(a, 'Maintenance').expect(201);
    const sub = await mk(a, 'Pumps', top.body.id).expect(201);
    const s1 = await ctx.http().post('/api/sops').set(as(a, 'EDITOR')).send({ name: 'In top', folderId: top.body.id }).expect(201);
    const s2 = await ctx.http().post('/api/sops').set(as(a, 'EDITOR')).send({ name: 'In sub', folderId: sub.body.id }).expect(201);
    const direct = await ctx.http().get(`/api/sops?folderId=${top.body.id}`).set(as(a, 'EDITOR')).expect(200);
    expect(direct.body.items.map((i: { id: string }) => i.id)).toEqual([s1.body.id]);
    const deep = await ctx.http().get(`/api/sops?folderId=${top.body.id}&includeSubfolders=true`).set(as(a, 'EDITOR')).expect(200);
    expect(deep.body.items.map((i: { id: string }) => i.id).sort()).toEqual([s1.body.id, s2.body.id].sort());
    const folders = await ctx.http().get('/api/folders').set(as(a, 'EDITOR')).expect(200);
    expect(folders.body.find((f: { id: string }) => f.id === top.body.id).sopCount).toBe(1);
    await ctx.http().get('/api/sops?folderId=not-a-uuid').set(as(a, 'EDITOR')).expect(400);

    // move a SOP between folders
    const moved = await ctx.http().patch(`/api/sops/${s2.body.id}`).set(as(a, 'EDITOR')).send({ folderId: top.body.id }).expect(200);
    expect(moved.body.folder.id).toBe(top.body.id);
  });

  it('only empty folders can be deleted (soft delete)', async () => {
    const f = await mk(a, 'Temp').expect(201);
    const sop = await ctx.http().post('/api/sops').set(as(a, 'EDITOR')).send({ name: 'Occupant', folderId: f.body.id }).expect(201);
    await ctx.http().delete(`/api/folders/${f.body.id}`).set(as(a, 'EDITOR')).expect(409);
    await ctx.http().patch(`/api/sops/${sop.body.id}`).set(as(a, 'EDITOR')).send({ folderId: null }).expect(200);
    await ctx.http().delete(`/api/folders/${f.body.id}`).set(as(a, 'EDITOR')).expect(204);
    const row = await ctx.prisma.folder.findUniqueOrThrow({ where: { id: f.body.id } });
    expect(row.deletedAt).not.toBeNull();
  });
});

describe('cross-tenant isolation — folders', () => {
  it('tenant B cannot see, edit, delete, nest under, or file SOPs into tenant A’s folders', async () => {
    const f = await mk(a, 'Secret folder').expect(201);
    const B = as(b, 'OWNER');
    const list = await ctx.http().get('/api/folders').set(B).expect(200);
    expect(list.body.map((x: { id: string }) => x.id)).not.toContain(f.body.id);
    await expectCrossTenantNotFound(() => ctx.http().patch(`/api/folders/${f.body.id}`).set(B).send({ name: 'pwned' }));
    await expectCrossTenantNotFound(() => ctx.http().delete(`/api/folders/${f.body.id}`).set(B));
    await expectCrossTenantNotFound(() => ctx.http().post('/api/folders').set(B).send({ name: 'child', parentId: f.body.id }));
    await ctx.http().post('/api/sops').set(B).send({ name: 'x', folderId: f.body.id }).expect(400);
    const filtered = await ctx.http().get(`/api/sops?folderId=${f.body.id}&includeSubfolders=true`).set(B).expect(200);
    expect(filtered.body.items).toEqual([]);
  });
});
