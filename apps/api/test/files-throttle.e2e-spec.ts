/**
 * Pages such as the Kanbans list show hundreds of pictures at once. Every picture is a signed `/api/files/...` URL, so
 * that route must not be rate-limited per visitor like the API is — otherwise most pictures come back 429 and show as broken.
 * (The signature + expiry already protect it.)
 */
import { OrgRole } from '@prisma/client';
import { createTenant, createTestApp, resetDatabase, Tenant, TestContext } from './harness';
import { PNG_1PX } from './sop-helpers';

let ctx: TestContext;
let t: Tenant;
const as = (role: OrgRole) => t.users[role].auth;

beforeAll(async () => {
  process.env.ENABLE_THROTTLE_IN_TEST = '1'; // the limiter is normally off under test
  ctx = await createTestApp();
  await resetDatabase(ctx.prisma);
  t = await createTenant(ctx, 'files');
});
afterAll(async () => {
  delete process.env.ENABLE_THROTTLE_IN_TEST;
  await ctx.close();
});

describe('signed file URLs', () => {
  it('are not rate-limited, while ordinary API routes still are', async () => {
    const up = await ctx.http().post('/api/media').set(as('EDITOR')).attach('file', PNG_1PX, { filename: 'a.png', contentType: 'image/png' }).expect(201);
    const fileUrl: string = up.body.url;

    // control: the limiter really is on — an ordinary route gets refused once the per-minute budget is spent
    const statuses: number[] = [];
    for (let i = 0; i < 130; i++) statuses.push((await ctx.http().get(`/api/media/${up.body.id}`).set(as('EDITOR'))).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);

    // 500 picture requests in one minute, as the Kanbans list makes, all succeed
    const files: number[] = [];
    for (let i = 0; i < 500; i++) files.push((await ctx.http().get(fileUrl)).status);
    expect(files.filter((s) => s !== 200)).toEqual([]);
  });
});
