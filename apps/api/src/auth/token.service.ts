import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { AccessTokenPayload } from '../common/auth-user';
import { env } from '../config/env';
import { PrismaService, Tx } from '../prisma/prisma.service';

export const IMPERSONATION_TTL_SECONDS = 3600;

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export type RotateResult =
  | { ok: true; userId: string; refreshToken: string }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'reuse_detected'; userId?: string };

/**
 * §7.4 refresh-token rules:
 *  - stored as SHA-256 hash only;
 *  - rotated on every refresh, old token invalidated immediately;
 *  - presenting an already-rotated token revokes the whole family;
 *  - password reset / role change / removal revoke all families (revokeAllForUser).
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  signAccessToken(user: Pick<User, 'id' | 'organizationId' | 'orgRole' | 'tokenVersion'>): string {
    const payload: AccessTokenPayload = {
      sub: user.id,
      org: user.organizationId,
      role: user.orgRole,
      tv: user.tokenVersion,
    };
    return this.jwt.sign(payload, {
      secret: env.jwtAccessSecret,
      algorithm: 'HS256',
      expiresIn: env.jwtAccessTtlSeconds,
    });
  }

  /**
   * Access token for "Impersonate": identifies the target user, carries the Admin's id, lives for one hour and has
   * no refresh token, so it cannot be renewed without going back through the Admin.
   */
  signImpersonationToken(target: Pick<User, 'id' | 'organizationId' | 'orgRole' | 'tokenVersion'>, adminId: string): string {
    const payload: AccessTokenPayload = { sub: target.id, org: target.organizationId, role: target.orgRole, tv: target.tokenVersion, imp: adminId };
    return this.jwt.sign(payload, { secret: env.jwtAccessSecret, algorithm: 'HS256', expiresIn: IMPERSONATION_TTL_SECONDS });
  }

  async issueRefreshToken(
    userId: string,
    opts: { familyId?: string; ip?: string; userAgent?: string } = {},
    tx?: Tx,
  ): Promise<string> {
    const raw = randomBytes(32).toString('base64url');
    await (tx ?? this.prisma).refreshToken.create({
      data: {
        userId,
        familyId: opts.familyId ?? randomUUID(),
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() + env.refreshTtlDays * 86_400_000),
        ip: opts.ip,
        userAgent: opts.userAgent,
      },
    });
    return raw;
  }

  async rotate(raw: string, meta: { ip?: string; userAgent?: string } = {}): Promise<RotateResult> {
    const existing = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(raw) } });
    if (!existing) return { ok: false, reason: 'unknown' };

    if (existing.rotatedAt) {
      // Reuse of an already-rotated token ⇒ revoke the entire family.
      await this.revokeFamily(existing.familyId, 'reuse_detected');
      return { ok: false, reason: 'reuse_detected', userId: existing.userId };
    }
    if (existing.revokedAt) return { ok: false, reason: 'revoked', userId: existing.userId };
    if (existing.expiresAt <= new Date()) return { ok: false, reason: 'expired', userId: existing.userId };

    return this.prisma.$transaction(async (tx) => {
      // Conditional update makes rotation race-safe: of two concurrent refreshes
      // with the same token, only one can flip rotatedAt from NULL.
      const claimed = await tx.refreshToken.updateMany({
        where: { id: existing.id, rotatedAt: null, revokedAt: null },
        data: { rotatedAt: new Date() },
      });
      if (claimed.count !== 1) {
        await tx.refreshToken.updateMany({
          where: { familyId: existing.familyId, revokedAt: null },
          data: { revokedAt: new Date(), revokeReason: 'reuse_detected' },
        });
        return { ok: false as const, reason: 'reuse_detected' as const, userId: existing.userId };
      }
      const next = await this.issueRefreshToken(
        existing.userId,
        { familyId: existing.familyId, ...meta },
        tx,
      );
      return { ok: true as const, userId: existing.userId, refreshToken: next };
    });
  }

  async revokeByRaw(raw: string, reason: string): Promise<void> {
    const existing = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(raw) } });
    if (existing) await this.revokeFamily(existing.familyId, reason);
  }

  async revokeFamily(familyId: string, reason: string, tx?: Tx): Promise<void> {
    await (tx ?? this.prisma).refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
  }

  /** Revokes every refresh family AND invalidates outstanding access tokens. */
  async revokeAllForUser(userId: string, reason: string, tx?: Tx): Promise<void> {
    const client = tx ?? this.prisma;
    await client.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    await client.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
  }
}
