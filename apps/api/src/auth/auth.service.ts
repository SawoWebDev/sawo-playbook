import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OrgRole, User } from '@prisma/client';
import * as argon2 from 'argon2';
import { ActivityService } from '../analytics/activity.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { RequestMeta } from '../common/decorators';
import { orgIsUsable } from '../common/org-status';
import { env } from '../config/env';
import { isUniqueViolation, PrismaService } from '../prisma/prisma.service';
import { SignupDto, LoginDto } from './auth.dto';
import { TokenService } from './token.service';
import { decryptSecret, verifyTotp } from './totp';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

/** Returned instead of a session when the password was correct but a TOTP code is still required. */
export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
}

const MFA_AUDIENCE = 'gemba-mfa';

export interface PublicUser {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  role: OrgRole;
  passwordMustChange: boolean;
}

export function toPublicUser(u: User): PublicUser {
  return { id: u.id, organizationId: u.organizationId, email: u.email, name: u.name, role: u.orgRole, passwordMustChange: u.passwordMustChange };
}

// Used to equalise timing when the email does not exist.
const DUMMY_HASH_PROMISE = argon2.hash('gemba-dummy-password-for-timing');

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
    private readonly jwt: JwtService,
  ) {}

  /** Creates Organization + default OrganizationSettings + active Owner (§6.1a, Phase 0.5). */
  async signup(dto: SignupDto, meta: RequestMeta): Promise<SessionTokens> {
    const email = normaliseEmail(dto.email);
    const passwordHash = await argon2.hash(dto.password);
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const org = await tx.organization.create({
          data: { name: dto.organizationName.trim(), settings: { create: {} } },
        });
        const owner = await tx.user.create({
          data: {
            organizationId: org.id,
            email,
            name: dto.name.trim(),
            passwordHash,
            orgRole: OrgRole.ADMIN,
            status: 'active',
          },
        });
        await this.audit.record(
          { action: AuditAction.OrgCreated, organizationId: org.id, actorId: owner.id, entityType: 'organization', entityId: org.id, ...meta },
          tx,
        );
        return owner;
      });
      return this.startSession(user, meta);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException('An account with this email already exists');
      throw err;
    }
  }

  async login(dto: LoginDto, meta: RequestMeta): Promise<SessionTokens | MfaChallenge> {
    const email = normaliseEmail(dto.email);
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { organization: { select: { status: true } } },
    });

    if (!user || !user.passwordHash) {
      await argon2.verify(await DUMMY_HASH_PROMISE, dto.password).catch(() => false);
      await this.audit.record({ action: AuditAction.LoginFailure, metadata: { email, reason: 'unknown_user' }, ...meta });
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.audit.record({ action: AuditAction.LoginFailure, organizationId: user.organizationId, actorId: user.id, metadata: { reason: 'locked' }, ...meta });
      throw new UnauthorizedException('Account temporarily locked');
    }

    const valid = await argon2.verify(user.passwordHash, dto.password).catch(() => false);
    if (!valid) {
      await this.recordFailure(user, 'bad_password', meta);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.status !== 'active' || !orgIsUsable(user.organization.status)) {
      await this.audit.record({ action: AuditAction.LoginFailure, organizationId: user.organizationId, actorId: user.id, metadata: { reason: `status_${user.status}` }, ...meta });
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.mfaEnabled && user.mfaSecretEnc) {
      const mfaToken = await this.jwt.signAsync(
        { sub: user.id, tv: user.tokenVersion },
        { secret: env.jwtAccessSecret, algorithm: 'HS256', audience: MFA_AUDIENCE, expiresIn: 300 },
      );
      return { mfaRequired: true, mfaToken };
    }
    return this.completeLogin(user, meta);
  }

  /** Second login step: short-lived MFA token from step one + a TOTP code (replay-protected). */
  async loginMfa(mfaToken: string, code: string, meta: RequestMeta): Promise<SessionTokens> {
    let payload: { sub: string; tv: number };
    try {
      payload = await this.jwt.verifyAsync(mfaToken, { secret: env.jwtAccessSecret, algorithms: ['HS256'], audience: MFA_AUDIENCE });
    } catch {
      throw new UnauthorizedException('MFA session expired — sign in again');
    }
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub }, include: { organization: { select: { status: true } } } });
    if (!user || user.tokenVersion !== payload.tv || user.status !== 'active' || !orgIsUsable(user.organization.status) || !user.mfaEnabled || !user.mfaSecretEnc) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) throw new UnauthorizedException('Account temporarily locked');
    const step = verifyTotp(decryptSecret(user.mfaSecretEnc), code.trim());
    if (step === null || (user.mfaLastStep !== null && step <= user.mfaLastStep)) {
      await this.recordFailure(user, 'bad_mfa_code', meta);
      throw new UnauthorizedException('Invalid authentication code');
    }
    // Conditional update: a concurrent request with the same code cannot also succeed.
    const claimed = await this.prisma.user.updateMany({
      where: { id: user.id, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] },
      data: { mfaLastStep: step },
    });
    if (claimed.count !== 1) throw new UnauthorizedException('Invalid authentication code');
    return this.completeLogin(user, meta);
  }

  private async recordFailure(user: User, reason: string, meta: RequestMeta) {
    const failed = user.failedLogins + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLogins: lock ? 0 : failed,
        lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : undefined,
      },
    });
    await this.audit.record({
      action: lock ? AuditAction.LoginLocked : AuditAction.LoginFailure,
      organizationId: user.organizationId,
      actorId: user.id,
      metadata: { reason, failedLogins: failed },
      ...meta,
    });
  }

  private async completeLogin(user: User, meta: RequestMeta): Promise<SessionTokens> {
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    await this.audit.record({ action: AuditAction.LoginSuccess, organizationId: user.organizationId, actorId: user.id, metadata: { mfa: user.mfaEnabled }, ...meta });
    await this.activity.emit({ organizationId: user.organizationId, actorId: user.id, eventType: 'user.login', entityType: 'user', entityId: user.id });
    return this.startSession(updated, meta);
  }

  async refresh(raw: string | undefined, meta: RequestMeta): Promise<SessionTokens> {
    if (!raw) throw new UnauthorizedException();
    const result = await this.tokens.rotate(raw, meta);
    if (!result.ok) {
      if (result.reason === 'reuse_detected' && result.userId) {
        const u = await this.prisma.user.findUnique({ where: { id: result.userId } });
        await this.audit.record({ action: AuditAction.RefreshReuseDetected, organizationId: u?.organizationId, actorId: result.userId, ...meta });
      }
      throw new UnauthorizedException();
    }
    const user = await this.prisma.user.findUnique({
      where: { id: result.userId },
      include: { organization: { select: { status: true } } },
    });
    if (!user || user.status !== 'active' || !orgIsUsable(user.organization.status)) {
      await this.tokens.revokeByRaw(result.refreshToken, 'user_inactive');
      throw new UnauthorizedException();
    }
    return { accessToken: this.tokens.signAccessToken(user), refreshToken: result.refreshToken, user: toPublicUser(user) };
  }

  async logout(raw: string | undefined, actor: { id?: string; organizationId?: string }, meta: RequestMeta) {
    if (raw) await this.tokens.revokeByRaw(raw, 'logout');
    await this.audit.record({ action: AuditAction.Logout, organizationId: actor.organizationId, actorId: actor.id, ...meta });
  }

  async startSession(user: User, meta: RequestMeta): Promise<SessionTokens> {
    const refreshToken = await this.tokens.issueRefreshToken(user.id, meta);
    return { accessToken: this.tokens.signAccessToken(user), refreshToken, user: toPublicUser(user) };
  }
}
