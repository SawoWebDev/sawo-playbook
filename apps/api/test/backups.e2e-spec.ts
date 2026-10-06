/**
 * Full-organization backup (one .zip with every SOP, version, step and image) and restore.
 * The round-trip test is the contract: what goes into a backup must come back out identical.
 */
import archiver from 'archiver';
import { createHash } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { OrgRole } from '@prisma/client';
import { ZipReader } from '../src/backups/zip-reader';
import { StorageService } from '../src/storage/storage.service';
import { createTenant, createTestApp, resetDatabase, Tenant, TestContext } from './harness';
import { PNG_1PX, sopHelpers } from './sop-helpers';

let ctx: TestContext;
let a: Tenant;
let b: Tenant;
let tmp: string;
let storage: StorageService;
const h = sopHelpers(() => ctx);
const as = (t: Tenant, role: OrgRole) => t.users[role].auth;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
const PNG_2 = Buffer.concat([PNG_1PX, Buffer.from('second-image')]);

beforeAll(async () => {
  ctx = await createTestApp();
  storage = ctx.app.get(StorageService);
  await resetDatabase(ctx.prisma);
  a = await createTenant(ctx, 'alpha');
  b = await createTenant(ctx, 'beta');
  tmp = await mkdtemp(join(tmpdir(), 'backup-test-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
  await ctx.close();
});

async function uploadMedia(t: Tenant, buf: Buffer, name: string): Promise<string> {
  const res = await ctx.http().post('/api/media').set(as(t, 'EDITOR')).attach('file', buf, { filename: name, contentType: 'image/png' }).expect(201);
  return res.body.id as string;
}

async function waitForJob(t: Tenant, id: string, role: OrgRole = 'OWNER') {
  for (let i = 0; i < 400; i++) {
    const res = await ctx.http().get(`/api/backups/${id}`).set(as(t, role)).expect(200);
    if (res.body.status !== 'running') return res.body;
    await sleep(25);
  }
  throw new Error('backup job did not finish');
}

async function exportBackup(t: Tenant): Promise<{ job: any; zip: Buffer }> {
  const start = await ctx.http().post('/api/backups').set(as(t, 'OWNER')).expect(202);
  const job = await waitForJob(t, start.body.id);
  expect(job.status).toBe('done');
  const link = await ctx.http().post(`/api/backups/${job.id}/download-link`).set(as(t, 'OWNER')).expect(200);
  const dl = await ctx
    .http()
    .get(link.body.url)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    })
    .expect(200);
  return { job, zip: dl.body as Buffer };
}

async function restore(t: Tenant, zip: Buffer, dryRun: boolean) {
  const start = await ctx
    .http()
    .post(`/api/backups/restore${dryRun ? '?dryRun=true' : ''}`)
    .set(as(t, 'OWNER'))
    .attach('file', zip, { filename: 'backup.zip', contentType: 'application/zip' })
    .expect(202);
  return waitForJob(t, start.body.id);
}

async function openZip(buf: Buffer): Promise<ZipReader> {
  const path = join(tmp, `${Math.random().toString(36).slice(2)}.zip`);
  await writeFile(path, buf);
  return ZipReader.open(path);
}

/** Unpacks a backup, lets the test tamper with its files, and packs it again. */
async function rewrite(zip: Buffer, mutate: (files: Map<string, Buffer>) => void): Promise<Buffer> {
  const reader = await openZip(zip);
  const files = new Map<string, Buffer>();
  for (const name of reader.entries.keys()) files.set(name, await reader.read(name, 50 * 1024 * 1024));
  reader.close();
  mutate(files);
  const archive = archiver('zip');
  const chunks: Buffer[] = [];
  archive.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', resolve);
    archive.on('error', reject);
  });
  for (const [name, data] of files) archive.append(data, { name });
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

/** Everything about an org's SOPs that a backup must preserve, with ids replaced by stable descriptions. */
async function snapshot(orgId: string) {
  const sops = await ctx.prisma.sop.findMany({
    where: { organizationId: orgId, deletedAt: null },
    orderBy: { referenceNo: 'asc' },
    include: {
      folder: true,
      versions: {
        orderBy: { versionSequence: 'asc' },
        include: { steps: { orderBy: { order: 'asc' }, include: { linkedSop: true, media: { orderBy: { displayOrder: 'asc' }, include: { mediaAsset: true } } } } },
      },
    },
  });
  return Promise.all(
    sops.map(async (s) => ({
      referenceNo: s.referenceNo,
      name: s.name,
      type: s.type,
      status: s.status,
      folder: s.folder?.name ?? null,
      archived: !!s.archivedAt,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      hasPublished: !!s.currentPublishedVersionId,
      versions: await Promise.all(
        s.versions.map(async (v) => ({
          sequence: v.versionSequence,
          state: v.lifecycleState,
          config: v.config,
          changeSummary: v.changeSummary,
          createdAt: v.createdAt.toISOString(),
          publishedAt: v.publishedAt?.toISOString() ?? null,
          steps: await Promise.all(
            v.steps.map(async (st) => ({
              order: st.order,
              title: st.title,
              description: st.description,
              isCritical: st.isCritical,
              plannedTimeSeconds: st.plannedTimeSeconds,
              linksTo: st.linkedSop?.referenceNo ?? null,
              media: await Promise.all(
                st.media.map(async (m) => ({
                  displayOrder: m.displayOrder,
                  filename: m.mediaAsset.originalFilename,
                  mimeType: m.mediaAsset.mimeType,
                  sha256: sha(await storage.get(m.mediaAsset.storageKey)),
                })),
              ),
            })),
          ),
        })),
      ),
    })),
  );
}

/** Everything about an org's kanbans that a backup must preserve. */
async function kanbanSnapshot(orgId: string) {
  const rows = await ctx.prisma.kanban.findMany({
    where: { organizationId: orgId, deletedAt: null },
    orderBy: { partCode: 'asc' },
    include: { picture: true, orderingSop: true, media: { include: { mediaAsset: true } } },
  });
  return Promise.all(
    rows.map(async (k) => ({
      partCode: k.partCode,
      partDescription: k.partDescription,
      supplier: k.supplier,
      supplierPartNo: k.supplierPartNo,
      orderQty: k.orderQty,
      price: k.price?.toFixed(2) ?? null,
      carriage: k.carriage?.toFixed(2) ?? null,
      orderingType: k.orderingType,
      orderingUrl: k.orderingUrl,
      orderingSop: k.orderingSop?.referenceNo ?? null,
      tag: k.tag,
      color: k.color,
      template: k.template,
      createdAt: k.createdAt.toISOString(),
      updatedAt: k.updatedAt.toISOString(),
      picture: k.picture ? sha(await storage.get(k.picture.storageKey)) : null,
      extraImages: (await Promise.all(k.media.map(async (m) => sha(await storage.get(m.mediaAsset.storageKey))))).sort(),
    })),
  );
}

describe('backup & restore', () => {
  let source: { zip: Buffer; job: any };

  beforeAll(async () => {
    const img1 = await uploadMedia(a, PNG_1PX, 'one.png');
    const img2 = await uploadMedia(a, PNG_2, 'two.png');
    const folder = await ctx.http().post('/api/folders').set(as(a, 'EDITOR')).send({ name: 'Line 1' }).expect(201);

    // Alpha: two published versions, with config, rich text, two images and a zero-duration step
    const alpha = await h.publishedSop(a, {
      name: 'Alpha',
      config: { checklist_sop: true, cover_sheet: true },
      steps: [
        { description: '<p>Soak &amp; dry <b>fully</b></p>', plannedTimeSeconds: 45, isCritical: true, media: [{ mediaAssetId: img1 }, { mediaAssetId: img2 }] },
        { description: 'Second step', plannedTimeSeconds: 0 },
      ],
    });
    const alphaV2 = await h.republish(a, alpha.sopId, [{ description: 'Revised step', plannedTimeSeconds: 5, media: [{ mediaAssetId: img2 }] }]);

    // Beta: a draft that has never been published, in a folder, sharing an image with Alpha
    const beta = await h.createSop(a, 'Beta');
    await h.saveSteps(a, beta.sopId, beta.versionId, [{ description: 'Draft step', media: [{ mediaAssetId: img1 }] }]);
    await ctx.http().patch(`/api/sops/${beta.sopId}`).set(as(a, 'EDITOR')).send({ folderId: folder.body.id }).expect(200);

    // Gamma: published, with a step that points at Alpha's published v2
    await h.publishedSop(a, { name: 'Gamma', steps: [{ description: 'See Alpha', linkedSopId: alpha.sopId, linkedSopVersionId: alphaV2 }] });

    // Delta: published then archived; plus original reference numbers and historic dates as an imported SOP would have
    const delta = await h.publishedSop(a, { name: 'Delta' });
    await ctx.http().post(`/api/sops/${delta.sopId}/archive`).set(as(a, 'ADMIN')).send({ archived: true }).expect(200);
    await ctx.prisma.sop.update({ where: { id: alpha.sopId }, data: { referenceNo: '232', createdAt: new Date('2025-01-02T00:00:00Z'), updatedAt: new Date('2025-02-03T00:00:00Z') } });
    await ctx.prisma.sop.update({ where: { id: beta.sopId }, data: { referenceNo: '231', createdAt: new Date('2025-01-01T00:00:00Z'), updatedAt: new Date('2025-01-01T00:00:00Z') } });

    // Kanbans: one ordering from an SOP with a picture + extra image + prices, one plain URL kanban with no picture
    const img3 = await uploadMedia(a, Buffer.concat([PNG_1PX, Buffer.from('third-image')]), 'three.png');
    const k1Draft = await ctx
      .http()
      .post('/api/kanbans')
      .set(as(a, 'EDITOR'))
      .send({ partCode: 'K-100', partDescription: 'Bearing 6204', supplier: 'ACME', supplierPartNo: 'A-1', orderQty: '100 PCS', pictureAssetId: img1, mediaAssetIds: [img3], orderingType: 'sop', orderingSopId: alpha.sopId, price: 12.5, carriage: 1.25, template: '02', tag: 'bearings', color: '#D0F0C0' })
      .expect(201);
    const k1 = await ctx.http().post(`/api/kanbans/revisions/${k1Draft.body.id}/publish`).set(as(a, "APPROVER")).expect(200);
    const k200 = await ctx.http().post('/api/kanbans').set(as(a, 'EDITOR')).send({ partCode: 'K-200', orderingType: 'url', orderingUrl: 'https://example.test/order' }).expect(201);
    await ctx.http().post(`/api/kanbans/revisions/${k200.body.id}/publish`).set(as(a, 'APPROVER')).expect(200);
    await ctx.prisma.kanban.update({ where: { id: k1.body.id }, data: { createdAt: new Date('2025-03-04T00:00:00Z'), updatedAt: new Date('2025-03-05T00:00:00Z') } });

    source = await exportBackup(a);
  });

  it('only organization managers can use it', async () => {
    await ctx.http().post('/api/backups').expect(401);
    for (const role of ['EDITOR', 'OPERATOR', 'APPROVER'] as OrgRole[]) {
      await ctx.http().post('/api/backups').set(as(a, role)).expect(403);
      await ctx.http().get('/api/backups').set(as(a, role)).expect(403);
      await ctx.http().post('/api/backups/restore').set(as(a, role)).attach('file', Buffer.from('x'), 'x.zip').expect(403);
    }
    await ctx.http().get('/api/backups').set(as(a, 'ADMIN')).expect(200);
  });

  it('writes a manifest, every SOP, and every image with a matching checksum', async () => {
    expect(source.job.file.counts).toEqual({ sops: 4, versions: 5, steps: 7, kanbans: 2, media: 3 });
    expect(source.job.warnings).toEqual([]);
    expect(source.job.percent).toBe(100);

    const zip = await openZip(source.zip);
    const manifest = await zip.readJson<any>('manifest.json', 1e6);
    expect(manifest).toMatchObject({ format: 'gembadocs-sop-backup', formatVersion: 1, counts: { sops: 4, versions: 5, steps: 7, kanbans: 2, media: 3 }, files: { kanbans: 'kanbans.json' } });
    expect(manifest.files.sops).toHaveLength(4);
    const media = await zip.readJson<any[]>('media.json', 1e6);
    expect(media.map((m) => m.originalFilename).sort()).toEqual(['one.png', 'three.png', 'two.png']);
    for (const m of media) expect(sha(await zip.read(m.file, 1e7))).toBe(m.sha256);
    const sops = await Promise.all(manifest.files.sops.map((f: string) => zip.readJson<any>(f, 1e6)));
    // newest first, exactly like the list; each SOP carries all its versions
    expect(sops.map((s) => s.name)).toEqual(['Delta', 'Gamma', 'Alpha', 'Beta']);
    expect(sops.find((s) => s.name === 'Alpha').versions.map((v: any) => v.versionSequence)).toEqual([1, 2]);
    const kanbans = await zip.readJson<any[]>('kanbans.json', 1e6);
    expect(kanbans.map((k) => k.partCode)).toEqual(['K-200', 'K-100']); // newest first
    expect(kanbans.find((k) => k.partCode === 'K-100')).toMatchObject({ price: '12.50', carriage: '1.25', orderingType: 'sop', template: '02', mediaAssetIds: expect.any(Array) });
    zip.close();
  });

  it('restores into another organization exactly as it was', async () => {
    const before = await snapshot(a.organizationId);
    const beforeKanbans = await kanbanSnapshot(a.organizationId);
    const job = await restore(b, source.zip, false);
    expect(job.status).toBe('done');
    expect(job.summary).toMatchObject({ dryRun: false, created: 4, versions: 5, steps: 7, mediaCreated: 3, kanbans: { inFile: 2, created: 2, skipped: 0, failed: [] } });
    expect(job.summary.failed).toEqual([]);
    expect(job.summary.skipped).toEqual([]);
    expect(job.percent).toBe(100);

    expect(await snapshot(b.organizationId)).toEqual(before);
    expect(await kanbanSnapshot(b.organizationId)).toEqual(beforeKanbans);
    expect((await kanbanSnapshot(b.organizationId)).find((k) => k.partCode === 'K-100')).toMatchObject({ orderingSop: '232', price: '12.50', picture: sha(PNG_1PX) });
    // the source organization is untouched
    expect(await snapshot(a.organizationId)).toEqual(before);
    expect(await kanbanSnapshot(a.organizationId)).toEqual(beforeKanbans);

    const restored = await ctx.prisma.sop.findMany({ where: { organizationId: b.organizationId }, include: { currentPublishedVersion: true, latestDraftVersion: true } });
    const byName = Object.fromEntries(restored.map((s) => [s.name, s]));
    expect(byName.Alpha.currentPublishedVersion?.versionSequence).toBe(2);
    expect(byName.Beta.latestDraftVersion?.lifecycleState).toBe('DRAFT');
    expect(byName.Beta.currentPublishedVersionId).toBeNull();
    expect(byName.Delta.status).toBe('archived');
    // restored images belong to the new organization and are readable through it
    const assets = await ctx.prisma.mediaAsset.findMany({ where: { organizationId: b.organizationId } });
    expect(assets).toHaveLength(3);
    expect(assets.every((m) => m.storageKey.startsWith(`org/${b.organizationId}/`))).toBe(true);
    // QR tokens are globally unique, so the copy gets fresh ones
    const tokens = (await ctx.prisma.sop.findMany({ select: { qrPublicToken: true } })).map((s) => s.qrPublicToken);
    expect(new Set(tokens).size).toBe(tokens.length);
    // the cross-SOP link points inside the new organization
    const gamma = await ctx.prisma.sopStep.findFirstOrThrow({ where: { organizationId: b.organizationId, linkedSopId: { not: null } }, include: { linkedSop: true } });
    expect(gamma.linkedSop?.organizationId).toBe(b.organizationId);
    expect(gamma.linkedSopVersionId).not.toBeNull();
  });

  it('a dry run checks the whole file but writes nothing', async () => {
    const c = await createTenant(ctx, 'gamma');
    const job = await restore(c, source.zip, true);
    expect(job.status).toBe('done');
    expect(job.dryRun).toBe(true);
    expect(job.summary).toMatchObject({ dryRun: true, created: 4, failed: [], kanbans: { created: 2 } });
    expect(await ctx.prisma.sop.count({ where: { organizationId: c.organizationId } })).toBe(0);
    expect(await ctx.prisma.mediaAsset.count({ where: { organizationId: c.organizationId } })).toBe(0);
    expect(await ctx.prisma.kanban.count({ where: { organizationId: c.organizationId } })).toBe(0);
  });

  it('skips SOPs that already exist instead of duplicating them', async () => {
    const before = await ctx.prisma.sop.count({ where: { organizationId: b.organizationId } });
    const job = await restore(b, source.zip, false);
    expect(job.summary.created).toBe(0);
    expect(job.summary.skipped).toHaveLength(4);
    expect(job.summary.kanbans).toMatchObject({ created: 0, skipped: 2 });
    expect(job.summary.skipped[0].reason).toMatch(/already exists/);
    expect(await ctx.prisma.sop.count({ where: { organizationId: b.organizationId } })).toBe(before);
    expect(await ctx.prisma.kanban.count({ where: { organizationId: b.organizationId } })).toBe(2);
  });

  it('keeps people distinct when their emails are free, and never grants more than the lowest role', async () => {
    const c = await createTenant(ctx, 'delta');
    const tampered = await rewrite(source.zip, (files) => {
      const users = JSON.parse(files.get('users.json')!.toString()) as { id: string; name: string; email: string }[];
      files.set('users.json', Buffer.from(JSON.stringify(users.map((u) => ({ ...u, email: `restored.${u.id}@example.test` })))));
    });
    const job = await restore(c, tampered, false);
    expect(job.status).toBe('done');
    expect(job.summary.usersCreated).toBeGreaterThan(0);
    const created = await ctx.prisma.user.findMany({ where: { organizationId: c.organizationId, email: { startsWith: 'restored.' } } });
    expect(created.every((u) => u.orgRole === 'OPERATOR' && u.status === 'invited' && u.passwordHash === null)).toBe(true);
    const sop = await ctx.prisma.sop.findFirstOrThrow({ where: { organizationId: c.organizationId, name: 'Alpha' } });
    const creator = await ctx.prisma.user.findUniqueOrThrow({ where: { id: sop.createdById } });
    expect(creator.email).toMatch(/^restored\./);
  });

  it('treats the file as untrusted: sanitises text, drops damaged images, reports unreadable SOPs', async () => {
    const c = await createTenant(ctx, 'epsilon');
    const tampered = await rewrite(source.zip, (files) => {
      const manifest = JSON.parse(files.get('manifest.json')!.toString());
      const media = JSON.parse(files.get('media.json')!.toString()) as { file: string }[];
      files.set(media[0].file, Buffer.concat([files.get(media[0].file)!, Buffer.from('tampered')])); // checksum no longer matches
      const alphaFile = manifest.files.sops.find((f: string) => f.includes('232'));
      const alpha = JSON.parse(files.get(alphaFile)!.toString());
      alpha.versions[0].steps[0].description = '<p>ok</p><script>alert(1)</script><img src=x onerror=alert(2)>';
      files.set(alphaFile, Buffer.from(JSON.stringify(alpha)));
      const betaFile = manifest.files.sops.find((f: string) => f.includes('231'));
      files.set(betaFile, Buffer.from('{ this is not json'));
      const kanbans = JSON.parse(files.get('kanbans.json')!.toString());
      kanbans[0].template = 'bogus'; // one unreadable kanban must not stop the others
      files.set('kanbans.json', Buffer.from(JSON.stringify(kanbans)));
    });
    const job = await restore(c, tampered, false);
    expect(job.status).toBe('done');
    expect(job.summary.failed).toHaveLength(1);
    expect(job.summary.failed[0].referenceNo).toMatch(/231/);
    expect(job.summary.created).toBe(3);
    expect(job.summary.kanbans).toMatchObject({ inFile: 2, created: 1 });
    expect(job.summary.kanbans.failed).toHaveLength(1);
    expect(job.warnings.join('\n')).toMatch(/not restored: checksum does not match/);
    const steps = await ctx.prisma.sopStep.findMany({ where: { organizationId: c.organizationId } });
    expect(steps.some((s) => /<script|onerror/i.test(s.description))).toBe(false);
    expect(steps.some((s) => s.description.includes('ok'))).toBe(true);
  });

  it('rejects files that are not backups', async () => {
    const notZip = await restore(b, Buffer.from('definitely not a zip file'), true);
    expect(notZip.status).toBe('failed');
    expect(notZip.error).toMatch(/not a valid backup file/);

    const wrongFormat = await rewrite(source.zip, (files) => {
      const m = JSON.parse(files.get('manifest.json')!.toString());
      m.format = 'something-else';
      files.set('manifest.json', Buffer.from(JSON.stringify(m)));
    });
    const bad = await restore(b, wrongFormat, true);
    expect(bad.status).toBe('failed');
    expect(bad.error).toMatch(/not a SOP backup file/);
  });

  it('keeps backups private to their organization and links short-lived and tamper-proof', async () => {
    const id = source.job.id as string;
    await ctx.http().get(`/api/backups/${id}`).set(as(b, 'OWNER')).expect(404);
    await ctx.http().post(`/api/backups/${id}/download-link`).set(as(b, 'OWNER')).expect(404);
    await ctx.http().delete(`/api/backups/${id}`).set(as(b, 'OWNER')).expect(404);
    expect((await ctx.http().get('/api/backups').set(as(b, 'OWNER')).expect(200)).body.some((j: any) => j.id === id)).toBe(false);

    const link = await ctx.http().post(`/api/backups/${id}/download-link`).set(as(a, 'OWNER')).expect(200);
    await ctx.http().get(link.body.url.replace(/sig=[^&]+/, 'sig=forged')).expect(404);
    await ctx.http().get(link.body.url.replace(/exp=\d+/, 'exp=1')).expect(404);
    await ctx.http().get(link.body.url).expect(200);
  });

  it('lists past backups and can delete them', async () => {
    const list = await ctx.http().get('/api/backups').set(as(a, 'OWNER')).expect(200);
    expect(list.body.some((j: request.Response['body']) => j.id === source.job.id && j.file.sizeBytes > 0)).toBe(true);
    await ctx.http().delete(`/api/backups/${source.job.id}`).set(as(a, 'OWNER')).expect(204);
    await ctx.http().get(`/api/backups/${source.job.id}`).set(as(a, 'OWNER')).expect(404);
  });
});
