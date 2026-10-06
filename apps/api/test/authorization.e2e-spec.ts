/** Route declarations (§7.3 rule 2: every endpoint declares @Public() or @RequirePermission()) + §8 harness self-test. */
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { OrgRole } from '@prisma/client';
import { IS_PUBLIC_KEY, PERMISSION_KEY } from '../src/common/decorators';
import { createTenant, createTestApp, resetDatabase, TestContext } from './harness';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
  await resetDatabase(ctx.prisma);
});
afterAll(() => ctx.close());

describe('route permission declarations', () => {
  it('every HTTP route declares @Public() or @RequirePermission()', () => {
    const undeclared: string[] = [];
    let routes = 0;
    for (const mod of ctx.app.get(ModulesContainer).values()) {
      for (const wrapper of mod.controllers.values()) {
        const cls = wrapper.metatype as (new (...a: unknown[]) => unknown) | undefined;
        if (!cls) continue;
        const proto = cls.prototype as Record<string, unknown>;
        for (const name of Object.getOwnPropertyNames(proto)) {
          const handler = proto[name];
          if (name === 'constructor' || typeof handler !== 'function') continue;
          if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
          routes++;
          const declared =
            Reflect.getMetadata(IS_PUBLIC_KEY, handler) ??
            Reflect.getMetadata(IS_PUBLIC_KEY, cls) ??
            Reflect.getMetadata(PERMISSION_KEY, handler) ??
            Reflect.getMetadata(PERMISSION_KEY, cls);
          if (!declared) {
            const path = Reflect.getMetadata(PATH_METADATA, handler);
            undeclared.push(`${cls.name}.${name} ${RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler)]} ${path}`);
          }
        }
      }
    }
    expect(routes).toBeGreaterThan(0);
    expect(undeclared).toEqual([]);
  });
});

describe('cross-tenant harness (§8, Phase 0)', () => {
  it('creates isolated tenants with one user per role', async () => {
    const a = await createTenant(ctx, 'alpha');
    const b = await createTenant(ctx, 'beta');
    expect(a.organizationId).not.toBe(b.organizationId);
    for (const role of Object.values(OrgRole)) {
      const me = await ctx.http().get('/api/auth/me').set(a.users[role].auth).expect(200);
      expect(me.body.organizationId).toBe(a.organizationId);
      expect(me.body.role).toBe(role);
    }
  });

  it('a token signed for org A cannot be replayed with a forged org claim', async () => {
    const a = await createTenant(ctx, 'alpha');
    const b = await createTenant(ctx, 'beta');
    const forged = ctx.tokens.signAccessToken({ ...a.users.OWNER.user, organizationId: b.organizationId });
    await ctx.http().get('/api/auth/me').set('Authorization', `Bearer ${forged}`).expect(401);
  });
});
