/**
 * Cross-tenant test harness (§8). Every phase adds cases that use
 * `createTenant()` twice and assert that tenant B can neither read nor mutate
 * tenant A's resources (expect 404, never 403 — existence must not leak).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OrgRole, User } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/token.service';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma/prisma.service';

export const TEST_PASSWORD = 'correct-horse-battery-staple';
let passwordHashCache: Promise<string> | undefined;

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  tokens: TokenService;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

export async function createTestApp(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureApp(moduleRef.createNestApplication());
  await app.init();
  const prisma = app.get(PrismaService);
  return {
    app,
    prisma,
    tokens: app.get(TokenService),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

/** Wipes all application tables. TRUNCATE bypasses row-level immutability triggers by design. */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

export interface TenantUser {
  user: User;
  token: string;
  auth: { Authorization: string };
}

export interface Tenant {
  organizationId: string;
  users: Record<OrgRole, TenantUser>;
  /** A second Editor — Editors approve each other's versions (quorum needs distinct non-submitting approvers). */
  reviewer: TenantUser;
  /** Convenience: create another user in this tenant. */
  addUser: (role: OrgRole, label?: string) => Promise<TenantUser>;
}

let counter = 0;

export async function createTenant(ctx: TestContext, label = 'org'): Promise<Tenant> {
  const n = ++counter;
  const org = await ctx.prisma.organization.create({
    data: { name: `${label}-${n}`, settings: { create: {} } },
  });
  passwordHashCache ??= argon2.hash(TEST_PASSWORD);
  const passwordHash = await passwordHashCache;

  const addUser = async (role: OrgRole, userLabel = role.toLowerCase()): Promise<TenantUser> => {
    const user = await ctx.prisma.user.create({
      data: {
        organizationId: org.id,
        email: `${userLabel}-${n}-${Math.random().toString(36).slice(2, 8)}@${label}.test`,
        name: `${userLabel} ${n}`,
        orgRole: role,
        status: 'active',
        passwordHash,
      },
    });
    const token = ctx.tokens.signAccessToken(user);
    return { user, token, auth: { Authorization: `Bearer ${token}` } };
  };

  const users = {} as Record<OrgRole, TenantUser>;
  for (const role of Object.values(OrgRole)) users[role] = await addUser(role);
  const reviewer = await addUser('EDITOR', 'reviewer');
  return { organizationId: org.id, users, reviewer, addUser };
}

/** Re-sign a token after the user row changed (e.g. tokenVersion bump in tests). */
export async function refreshAuth(ctx: TestContext, tu: TenantUser): Promise<TenantUser> {
  const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: tu.user.id } });
  const token = ctx.tokens.signAccessToken(user);
  return { user, token, auth: { Authorization: `Bearer ${token}` } };
}

/**
 * Standard cross-tenant assertion: `attacker` performing `call` against a
 * resource owned by another tenant must receive 404.
 */
export async function expectCrossTenantNotFound(
  call: () => request.Test,
): Promise<void> {
  const res = await call();
  if (res.status !== 404) {
    throw new Error(`Expected cross-tenant access to return 404, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
}
